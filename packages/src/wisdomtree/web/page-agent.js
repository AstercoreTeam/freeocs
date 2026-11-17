/**
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * Copyright 2026 AstercoreTeam
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Adapted from the Zhihuishu Tampermonkey project for the FreeOCS page-agent bridge.
 */
(() => {
  'use strict';

  const CFG = {
    masteryThreshold: 85,        // 只处理掌握度低于该值的章节
    maxQuestionsPerExam: 80,
    maxChaptersPerRun: 100,
    answerTimeoutMs: 120000,
    crossDomainWaitMs: 30000,  // 跨域跳转后等待页面/脚本就绪的最长时间
    emptyPendingRetries: 3,    // 完成一套后没扫到待处理章节时的复查次数
    emptyPendingRetryMs: 3000, // 每次复查前等待时间
    maxAnswersPerChapter: 3,   // 同一章节掌握度仍不达标时最多重做次数
    maxNoTestAttempts: 2,      // 同一章节没有可用试题时最多尝试次数
    maxOpenFailAttempts: 2,    // 同一章节打不开（点不进学习页）时最多尝试次数
    allowShortAnswer: true,
    autoSubmit: false,
    debug: false,
  };

  const STORE = {
    courseUrl: 'zhs_auto_course_url',
    run: 'zhs_auto_run',
    progress: 'zhs_auto_chapter_progress_v2',
    runTried: 'zhs_auto_run_tried_v1',
    legacyVisited: 'zhs_auto_visited_v1',
    agentId: 'zhs_auto_agent_id_v1',
    panelPos: 'zhs_auto_panel_pos_v1',
    panelCollapsed: 'zhs_auto_panel_collapsed_v1',
  };

  const S = {
    running: false,
    busy: false,
    stopped: false,
    completedSets: 0,
    questionsAnswered: 0,
    errors: 0,
    lastLatency: null,
    lastBackendError: '',
    backendOnline: null,
    backendInfo: null,
    status: '初始化',
    agentId: '',
    startedAt: 0,
    hasRun: false,
    commandRevision: 0,
    recentLogs: [],
  };
  const agentStore = {};
  let storeSaveTimer = 0;
  let storeSavePromise = Promise.resolve();

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => Date.now();
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').replace(/[：:]/g, ':').trim();

  function gmGet(k, d) {
    return Object.prototype.hasOwnProperty.call(agentStore, k) ? agentStore[k] : d;
  }

  function gmSet(k, v) {
    try {
      if (v === null || v === undefined) {
        delete agentStore[k];
        localStorage.removeItem(k);
      } else {
        agentStore[k] = v;
        localStorage.setItem(k, JSON.stringify(v));
      }
    } catch (error) {
      if (v === null || v === undefined) delete agentStore[k];
      else agentStore[k] = v;
    }
    if (storeSaveTimer) clearTimeout(storeSaveTimer);
    storeSaveTimer = setTimeout(() => {
      void saveAgentStore().catch((error) => {
        S.backendOnline = false;
        console.warn('[ZHS-AUTO] 保存跨页面状态失败', error);
      });
    }, 200);
  }

  function moduleRequest(method, body = {}) {
    return __freeocs.request(`/api/module/wisdomtree/${method}`, {
      method: 'POST',
      body,
    });
  }

  async function loadAgentStore() {
    const response = await moduleRequest('storage-load');
    const saved = response?.data;
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) {
      throw new Error('智慧树页面状态格式无效');
    }
    for (const [key, value] of Object.entries(saved)) {
      agentStore[key] = value;
    }
    for (const key of Object.keys(STORE)) {
      if (Object.prototype.hasOwnProperty.call(agentStore, STORE[key])) continue;
      try {
        const raw = localStorage.getItem(STORE[key]);
        if (raw !== null) agentStore[STORE[key]] = JSON.parse(raw);
      } catch (error) {
        console.warn('[ZHS-AUTO] 读取本地状态失败', error);
      }
    }
  }

  async function saveAgentStore() {
    storeSaveTimer = 0;
    const snapshot = JSON.parse(JSON.stringify(agentStore));
    storeSavePromise = storeSavePromise.catch(() => {}).then(() =>
      moduleRequest('storage-save', { data: snapshot, agent_id: S.agentId })
    );
    try {
      await storeSavePromise;
    } catch (error) {
      console.warn('[ZHS-AUTO] 保存跨页面状态失败', error);
      throw error;
    }
  }

  async function flushAgentStore() {
    if (storeSaveTimer) {
      clearTimeout(storeSaveTimer);
      await saveAgentStore();
    } else {
      await storeSavePromise;
    }
  }

  async function navigate(url) {
    await flushAgentStore();
    location.href = url;
  }

  function log(msg, isError = false) {
    if (isError) console.error('[ZHS-AUTO]', msg); else console.log('[ZHS-AUTO]', msg);
    S.recentLogs.push({ message: String(msg), isError });
    if (S.recentLogs.length > 4) S.recentLogs.shift();
    reportAgentEvent('log', { message: msg, is_error: isError });
    refreshPanel();
    updatePanel();
  }

  function setStatus(text) {
    S.status = text;
    refreshPanel();
    updatePanel();
  }

  /* ------------------------------------------------------------------ */
  /* 页面悬浮状态窗                                                     */
  /* ------------------------------------------------------------------ */
  const PANEL_ID = 'zhs-auto-panel-host';
  const PANEL_CSS = `
    .panel{width:238px;background:rgba(13,23,38,.95);color:#e3edf8;border:1px solid #2b3f5a;
      border-radius:10px;box-shadow:0 10px 26px rgba(0,0,0,.38);font:12px/1.5 "Segoe UI","Microsoft YaHei",sans-serif;
      overflow:hidden;user-select:none}
    .head{display:flex;align-items:center;gap:6px;padding:7px 9px;background:#16273d;cursor:move}
    .dot{width:8px;height:8px;border-radius:50%;background:#7d8ea3;flex:0 0 auto}
    .dot.on{background:#32c981;box-shadow:0 0 8px #32c981aa}
    .dot.warn{background:#e0a54a}
    .dot.err{background:#e56868}
    .title{flex:1 1 auto;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .head button{border:0;background:transparent;color:#93a4ba;font:inherit;cursor:pointer;padding:0 2px;line-height:1}
    .body{padding:8px 9px 9px}
    .line{display:flex;gap:8px;justify-content:space-between;margin-bottom:2px}
    .line span{color:#8fa2b8;flex:0 0 auto}
    .line b{font-weight:600;color:#dce8f6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .metrics{display:flex;gap:8px;color:#9fb4c9;margin-top:6px;font-size:11px}
    .logs{margin-top:6px;border-top:1px solid #22344a;padding-top:5px;color:#8fa2b8;font-size:11px}
    .logs div{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .logs div.err{color:#ff9b9b}
    .collapsed .body{display:none}
  `;

  let panelEls = null;
  let panelDrag = null;

  function setPanelText(el, text) {
    const value = String(text ?? '');
    if (el && el.textContent !== value) el.textContent = value;
  }

  function placePanel(host, left, top) {
    const maxLeft = Math.max(8, (window.innerWidth || 800) - 248);
    const maxTop = Math.max(8, (window.innerHeight || 600) - 60);
    host.style.left = `${Math.min(Math.max(8, left), maxLeft)}px`;
    host.style.top = `${Math.min(Math.max(8, top), maxTop)}px`;
  }

  function ensurePanel() {
    if (panelEls) return panelEls;
    if (!document.documentElement) return null;
    // 清掉可能残留的旧悬浮窗节点，保证拿到自己的引用
    document.getElementById(PANEL_ID)?.remove();
    {
      const host = document.createElement('div');
      host.id = PANEL_ID;
      host.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;';
      const shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
      shadow.innerHTML = `<style>${PANEL_CSS}</style>
        <div class="panel" id="panel">
          <div class="head" id="head">
            <span class="dot" id="dot"></span>
            <span class="title">智慧树自动答题</span>
            <button id="toggle" type="button" title="收起 / 展开">—</button>
          </div>
          <div class="body">
            <div class="line"><span>状态</span><b id="state">初始化</b></div>
            <div class="line"><span>操作</span><b id="action">等待启动</b></div>
            <div class="line"><span>后端</span><b id="backend">检测中</b></div>
            <div class="line"><span>页面</span><b id="page">-</b></div>
            <div class="line"><span>节奏</span><b id="pacing">1.5s ±0.5s</b></div>
            <div class="metrics"><span id="mSets">完成 0</span><span id="mQuestions">答题 0</span><span id="mErrors">错误 0</span></div>
            <div class="logs" id="logs"><div>等待脚本启动…</div></div>
          </div>
        </div>`;
      const pick = (id) => (shadow.getElementById ? shadow.getElementById(id) : shadow.querySelector(`#${id}`));
      panelEls = {
        host,
        panel: pick('panel'), head: pick('head'), dot: pick('dot'), toggle: pick('toggle'),
        state: pick('state'), action: pick('action'), backend: pick('backend'), page: pick('page'),
        pacing: pick('pacing'),
        mSets: pick('mSets'), mQuestions: pick('mQuestions'), mErrors: pick('mErrors'),
        logs: pick('logs'),
      };
      const saved = gmGet(STORE.panelPos, null);
      const defaultLeft = (window.innerWidth || 800) - 258;
      const defaultTop = (window.innerHeight || 600) - 226;
      placePanel(host, Number.isFinite(saved?.left) ? saved.left : defaultLeft,
        Number.isFinite(saved?.top) ? saved.top : defaultTop);
      if (gmGet(STORE.panelCollapsed, false)) panelEls.panel.classList.add('collapsed');
      panelEls.toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        const collapsed = panelEls.panel.classList.toggle('collapsed');
        gmSet(STORE.panelCollapsed, collapsed);
        setPanelText(panelEls.toggle, collapsed ? '+' : '—');
      });
      setPanelText(panelEls.toggle, gmGet(STORE.panelCollapsed, false) ? '+' : '—');
      panelEls.head.addEventListener('pointerdown', (event) => {
        if (event.target === panelEls.toggle) return;
        const rect = host.getBoundingClientRect();
        panelDrag = { left: rect.left, top: rect.top, x: event.clientX, y: event.clientY };
        try { panelEls.head.setPointerCapture?.(event.pointerId); } catch {}
      });
      panelEls.head.addEventListener('pointermove', (event) => {
        if (!panelDrag) return;
        placePanel(host, panelDrag.left + event.clientX - panelDrag.x, panelDrag.top + event.clientY - panelDrag.y);
      });
      const endDrag = () => {
        if (!panelDrag) return;
        panelDrag = null;
        gmSet(STORE.panelPos, {
          left: Math.round(host.getBoundingClientRect().left),
          top: Math.round(host.getBoundingClientRect().top),
        });
      };
      panelEls.head.addEventListener('pointerup', endDrag);
      panelEls.head.addEventListener('pointercancel', endDrag);
      document.documentElement.appendChild(host);
    }
    return panelEls;
  }

  const MODE_LABELS = {
    course: '课程目录', learn: '学习页', mastery: '掌握度页', exam: '考试页', result: '成绩页', other: '其他页面',
  };
  const modeLabel = (mode) => MODE_LABELS[mode] || mode || '-';

  function refreshPanel() {
    const els = ensurePanel();
    if (!els) return;
    const active = S.running || S.busy;
    els.dot.className = 'dot';
    if (S.backendOnline === false) els.dot.classList.add('err');
    else if (active) els.dot.classList.add('on');
    else if (S.backendOnline === null) els.dot.classList.add('warn');
    const stopped = /停止|失败|异常/.test(S.status) || S.hasRun;
    setPanelText(els.state, active ? '运行中' : (stopped ? '已停止' : '待启动'));
    setPanelText(els.action, S.status || '-');
    setPanelText(els.backend, S.backendOnline === null ? '检测中' : (S.backendOnline ? '在线' : '离线'));
    setPanelText(els.page, modeLabel(detectMode()));
    setPanelText(els.pacing, pacingLabel());
    setPanelText(els.mSets, `完成 ${S.completedSets}`);
    setPanelText(els.mQuestions, `答题 ${S.questionsAnswered}`);
    setPanelText(els.mErrors, `错误 ${S.errors}`);
    if (S.recentLogs.length) {
      const signature = S.recentLogs.map((item) => item.message).join('|');
      if (els.logs.dataset.signature !== signature) {
        els.logs.dataset.signature = signature;
        els.logs.replaceChildren();
        for (const item of S.recentLogs) {
          const row = document.createElement('div');
          if (item.isError) row.className = 'err';
          row.textContent = item.message;
          els.logs.appendChild(row);
        }
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* 页面判定                                                           */
  /* ------------------------------------------------------------------ */
  function isExamPage(pageLocation = location) {
    return /studentReviewTestOrExam/i.test(pageLocation.href)
      || (/(^|\.)examloop\.zhihuishu\.com$/i.test(pageLocation.hostname)
        && /^\/exam\//i.test(pageLocation.pathname));
  }
  const isCoursePage = () => /\/singleCourse\/knowledgeStudy\//i.test(location.pathname);
  const isLearnPage = () => /\/learnPage\//i.test(location.pathname);
  const isMasteryPage = () => /\/masteryHistory\//i.test(location.pathname);
  const isResultPage = () => /\/point\//i.test(location.pathname);

  /* ------------------------------------------------------------------ */
  /* 通用 DOM 工具                                                       */
  /* ------------------------------------------------------------------ */
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6 || r.bottom < -20 || r.top > innerHeight * 2.5) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && cs.opacity !== '0';
  }

  function laidOut(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 20) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden';
  }

  function textOf(el) {
    return norm(el?.innerText || el?.textContent || '');
  }

  function allClickables() {
    return [...document.querySelectorAll('button, a, [role="button"], div, span')]
      .filter((el) => visible(el));
  }

  function findButton(text, opts = {}) {
    const wanted = norm(text);
    const exact = opts.exact !== false;
    const list = allClickables().filter((el) => {
      const t = textOf(el);
      if (!t || t.length > 80) return false;
      return exact ? t === wanted : t.includes(wanted);
    });
    if (!list.length) return null;
    // 优先 button / role=button，再选面积最小的
    list.sort((a, b) => {
      const rank = (x) => (x.tagName === 'BUTTON' || x.getAttribute('role') === 'button' ? 0 : 1);
      const ar = a.getBoundingClientRect(), br = b.getBoundingClientRect();
      return rank(a) - rank(b) || (ar.width * ar.height) - (br.width * br.height);
    });
    return list[0];
  }

  function clickEl(el) {
    if (!el) return false;
    try { el.scrollIntoView({ block: 'center' }); } catch {}
    try {
      const r = el.getBoundingClientRect();
      const opts = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      el.dispatchEvent(new MouseEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new MouseEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.click();
      return true;
    } catch (e) {
      log('点击失败: ' + e.message, true);
      return false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 模拟人工点击节奏                                                   */
  /* ------------------------------------------------------------------ */
  // 默认每 1.5 秒点一次、±0.5 秒误差；具体数值由本机后端配置下发
  const PACING = { intervalMs: 1500, jitterMs: 500, lastAt: 0 };

  function applyClickSettings(click) {
    if (!click || typeof click !== 'object') return;
    const interval = Number(click.interval_ms ?? click.click_interval_ms);
    const jitter = Number(click.jitter_ms ?? click.click_jitter_ms);
    const nextInterval = Number.isFinite(interval) && interval > 0
      ? Math.min(10000, Math.max(200, Math.round(interval))) : PACING.intervalMs;
    const nextJitter = Number.isFinite(jitter) && jitter >= 0
      ? Math.min(5000, Math.max(0, Math.round(jitter))) : PACING.jitterMs;
    if (nextInterval === PACING.intervalMs && nextJitter === PACING.jitterMs) return;
    PACING.intervalMs = nextInterval;
    PACING.jitterMs = nextJitter;
    refreshPanel();
  }

  function applyModuleSettings(settings) {
    if (!settings || typeof settings !== 'object') return;
    const bounded = (key, fallback, min, max) => {
      const value = Number(settings[key]);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
    };
    CFG.masteryThreshold = bounded('mastery_threshold', 85, 0, 100);
    CFG.maxQuestionsPerExam = bounded('max_questions_per_exam', 80, 1, 200);
    CFG.maxChaptersPerRun = bounded('max_chapters_per_run', 100, 1, 500);
    CFG.answerTimeoutMs = bounded('answer_timeout', 120, 10, 600) * 1000;
    CFG.emptyPendingRetries = bounded('empty_pending_retries', 3, 0, 10);
    CFG.emptyPendingRetryMs = bounded('empty_pending_retry_ms', 3000, 1000, 10000);
    CFG.maxAnswersPerChapter = bounded('max_answers_per_chapter', 3, 1, 10);
    CFG.maxNoTestAttempts = bounded('max_no_test_attempts', 2, 1, 10);
    CFG.maxOpenFailAttempts = bounded('max_open_fail_attempts', 2, 1, 10);
    CFG.allowShortAnswer = settings.allow_short_answer !== false;
  }

  function pacingLabel() {
    return `${(PACING.intervalMs / 1000).toFixed(1)}s ±${(PACING.jitterMs / 1000).toFixed(1)}s`;
  }

  function nextClickDelay() {
    const jitter = PACING.jitterMs > 0 ? (Math.random() * 2 - 1) * PACING.jitterMs : 0;
    return Math.max(150, Math.round(PACING.intervalMs + jitter));
  }

  function describeElement(el) {
    if (!el) return '';
    const text = textOf(el);
    if (text) return text.slice(0, 40);
    const label = el.getAttribute?.('aria-label') || el.getAttribute?.('title') || el.getAttribute?.('placeholder');
    return String(label || el.tagName || '').slice(0, 40);
  }

  // 按“间隔 ± 误差”等待后再点击，并把操作上报给 FreeOCS
  async function humanClick(el, label) {
    const delay = nextClickDelay();
    const wait = PACING.lastAt + delay - now();
    if (wait > 0) {
      setStatus(`等待 ${(wait / 1000).toFixed(1)} 秒后点击${label ? '：' + label : ''}`);
      await sleep(wait);
    }
    if (S.stopped || !el) return false;
    PACING.lastAt = now();
    const name = label || describeElement(el);
    setStatus(`点击：${name}`);
    const ok = clickEl(el);
    reportAgentEvent('click', {
      label: name || '点击',
      target: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
      interval_ms: delay,
    });
    refreshPanel();
    return ok;
  }

  async function waitFor(fn, timeout = 10000, interval = 250) {
    const begin = now();
    while (now() - begin < timeout) {
      if (S.stopped) return null;
      try {
        const v = fn();
        if (v) return v;
      } catch {}
      await sleep(interval);
    }
    return null;
  }

  async function waitPath(re, timeout = 12000) {
    return waitFor(() => re.test(location.pathname) || re.test(location.href), timeout, 300);
  }

  function hash(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
  }

  /* ------------------------------------------------------------------ */
  /* 题目读取                                                           */
  /* ------------------------------------------------------------------ */
  const TYPE_RE = /(单选题|多选题|判断题|填空题|主观题|简答题)/;
  // 选项行可能写成 “A. 文本”“A 文本” 甚至 “A文本”（字母和文字分属不同元素）
  const OPTION_RE = /^([A-EＡ-Ｅ])\s*(?:[.．、,，:：)）]\s*|\s+)?(.+)$/s;
  const OPTION_KEY_ONLY_RE = /^([A-EＡ-Ｅ])\s*[.．、,，:：)）]?$/;
  const OPTION_ROW_SELECTOR = 'li, label, dd, p, [class*="checkbox"], [class*="radio"], [class*="option"], [class*="choice"], [class*="answer"]';

  function normalizeOptionKey(letter) {
    return String(letter || '').toUpperCase()
      .replace('Ａ', 'A').replace('Ｂ', 'B').replace('Ｃ', 'C').replace('Ｄ', 'D').replace('Ｅ', 'E');
  }

  function escapeRe(text) {
    return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // 解析“A. 文本”这类单行文本；字母后没有分隔符时要求不是英文/数字开头，避免误判
  function parseOptionLine(text) {
    const t = String(text || '').replace(/\u00a0/g, ' ').trim();
    if (!t || t.length > 240 || /[\n\r]/.test(t)) return null;
    const m = t.match(OPTION_RE);
    if (!m) return null;
    const rest = norm(m[2]);
    if (!rest || rest.length > 240 || OPTION_KEY_ONLY_RE.test(rest)) return null;
    // 只有标点的内容（如单独的 “A.”）不是选项文本
    if (!/[\u4e00-\u9fa5A-Za-z0-9]/.test(rest)) return null;
    if (!/^[A-EＡ-Ｅ][.．、,，:：)）\s]/.test(t) && /^[A-Za-z0-9]/.test(rest)) return null;
    return { key: normalizeOptionKey(m[1]), text: rest };
  }

  // 找出“只包含一个选项字母”的子元素（如 span.letterSort、el-checkbox 里的字母节点）
  function bareLetterEls(root, depth = 0) {
    const found = [];
    for (const child of root.children || []) {
      const raw = String(child.textContent || '').replace(/\s+/g, ' ').trim();
      if (!raw) continue;
      if (raw.length <= 8) {
        const m = raw.match(OPTION_KEY_ONLY_RE);
        if (m) {
          found.push({ el: child, key: normalizeOptionKey(m[1]), raw });
          continue;
        }
      }
      if (depth < 2 && child.children.length && raw.length <= 400) {
        found.push(...bareLetterEls(child, depth + 1));
      }
    }
    return found;
  }

  function optionTextFromRow(row, letterText) {
    let text = norm(row.innerText || row.textContent || '');
    if (letterText) text = text.replace(new RegExp('^' + escapeRe(norm(letterText)) + '\\s*'), '');
    return text.replace(/^[A-EＡ-Ｅ]\s*(?:[.．、,，:：)）]\s*|\s+)?/, '').trim();
  }

  function optionCandidates() {
    const map = new Map();
    const consider = (candidate) => {
      const old = map.get(candidate.key);
      if (!old) {
        map.set(candidate.key, candidate);
        return;
      }
      // 同一个 key 优先保留带输入框、层级更深的元素
      if (candidate.hasInput !== old.hasInput) {
        if (candidate.hasInput) map.set(candidate.key, candidate);
        return;
      }
      if (candidate.childCount < old.childCount) map.set(candidate.key, candidate);
    };

    // 1) 结构识别：选项行里字母和文字分属不同元素（单选/多选/Element UI 复选组都属于这种）
    for (const el of document.querySelectorAll(OPTION_ROW_SELECTOR)) {
      if (!visible(el) || el.closest('#zhs-auto-panel-host')) continue;
      const rawText = el.textContent || '';
      if (!rawText || rawText.length > 400) continue;
      if (el.querySelector('input[type="text"], input[type="number"], textarea, select')) continue;
      const letters = bareLetterEls(el);
      if (letters.length !== 1) continue;   // 含多个字母说明这是选项容器而不是选项行
      const text = optionTextFromRow(el, letters[0].raw);
      if (!text || text.length > 240 || OPTION_KEY_ONLY_RE.test(text)) continue;
      consider({
        key: letters[0].key,
        el,
        text,
        childCount: el.querySelectorAll('*').length,
        hasInput: !!el.querySelector('input'),
      });
    }

    // 2) 文本识别：字母和文字在同一行（“A. 文本”“A 文本”“A文本”）
    for (const el of document.querySelectorAll('body *')) {
      if (!visible(el) || el.closest('#zhs-auto-panel-host')) continue;
      if (el.querySelectorAll('*').length > 8) continue;
      const parsed = parseOptionLine(el.innerText || '');
      if (!parsed) continue;
      consider({
        key: parsed.key,
        el,
        text: parsed.text,
        childCount: el.querySelectorAll('*').length,
        hasInput: !!el.querySelector('input'),
      });
    }

    return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  function questionRoot(options) {
    if (!options.length) return null;
    const need = Math.min(2, options.length);
    let cur = options[0].el;
    // 离选项最近的、带题型标题且包含这些选项的容器就是题块
    for (let i = 0; i < 10 && cur && cur !== document.body; i++, cur = cur.parentElement) {
      if (!TYPE_RE.test(cur.innerText || '')) continue;
      if (options.filter((o) => cur.contains(o.el)).length >= need) return cur;
    }
    cur = options[0].el;
    for (let i = 0; i < 4 && cur && cur !== document.body; i++, cur = cur.parentElement) {}
    return cur || document.body;
  }

  // 题干容器：优先智慧树的 .questionName，避免把整块题目区域当题干
  function stemSource(root) {
    if (!root) return null;
    return root.matches?.('.questionName') ? root : root.querySelector?.('.questionName, .question-title, .subject-title') || root;
  }

  function detectType(root, options, inputs) {
    const t = root?.innerText || '';
    if (/多选题|多项选择|不定项/.test(t)) return 'multiple';
    if (/判断题/.test(t)) return 'judge';
    if (/(填空题|填空客观题)/.test(t)) return 'fill';
    if (/(主观题|简答题)/.test(t)) return 'short';
    if (/单选题|单项选择/.test(t)) return 'single';
    // 复选框类选项（Element UI el-checkbox、智慧树 checkbox-view）一定是多选
    if (root?.querySelector?.('input[type="checkbox"]')) return 'multiple';
    if (root?.querySelector?.('.checkbox-view, .checkbox-views, [class*="checkbox"]')) return 'multiple';
    if (inputs.length) return 'fill';
    if (options.length === 2 && options.every((o) => /^(对|错|正确|错误|是|否)$/.test(o.text))) return 'judge';
    return 'single';
  }

  // 题型标题行，例如 “3. 填空客观题（自动批阅）”“1. 多选题”
  const TYPE_TITLE_RE = /^\s*\d*\s*[.、]?\s*(单选题|多项选择题|多选题|判断题|填空题|填空客观题|主观题|简答题)\s*(（[^）]{0,12}）|\([^)]{0,12}\))?\s*[：:]?\s*$/;

  function stripQuestionText(root, options) {
    const optionKeys = new Set(options.map((option) => option.key));
    let lines = String(root?.innerText || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
    lines = lines.filter((line) => {
      if (!line) return false;
      if (TYPE_TITLE_RE.test(line)) return false;
      if (/^(答题进度|答题卡|已作答|未作答|上一题|下一题|提交作业|错题反馈)$/.test(line)) return false;
      // 填空序号行，如 (1)、（2）
      if (/^[（(]\s*\d+\s*[）)]$/.test(line)) return false;
      if (parseOptionLine(line)) return false;
      if (options.some((option) => norm(option.text) === norm(line))) return false;
      if (OPTION_KEY_ONLY_RE.test(line) && optionKeys.has(normalizeOptionKey(line[0]))) return false;
      return true;
    });
    return lines.join('\n').slice(0, 3000);
  }

  // 当前题块的题型标题（智慧树用 .letterSortNum / .questionTitle），取离视口中心最近的一个
  function currentQuestionTitle() {
    const nodes = [...document.querySelectorAll('.letterSortNum, .questionTitle')].filter((el) => visible(el));
    if (!nodes.length) return '';
    const center = (window.innerHeight || 600) / 2;
    let text = '';
    let bestDist = Infinity;
    for (const el of nodes) {
      const r = el.getBoundingClientRect();
      const dist = Math.abs(r.top + r.height / 2 - center);
      if (dist < bestDist) { bestDist = dist; text = textOf(el); }
    }
    return text;
  }

  function getInputs(root) {
    return [...root.querySelectorAll('input, textarea')].filter((el) => {
      if (!visible(el)) return false;
      if (el.type && /^(button|submit|reset|checkbox|radio|file|hidden)$/i.test(el.type)) return false;
      if (el.closest('header')) return false;
      return true;
    });
  }

  const SELECTED_CLASS_RE = /(^|\s)(is-checked|checked|checkedIcon|selected|sel|option-selected|active)(\s|$)/;

  function optionSelected(o) {
    const el = o.el;
    if (!el) return false;
    const inp = el.querySelector?.('input');
    if (inp && (inp.checked || inp.getAttribute('aria-checked') === 'true')) return true;
    if (el.querySelector?.('[aria-checked="true"], [aria-selected="true"], .is-checked, .checked, .selected, .checkedIcon')) return true;
    const examloopBadge = el.querySelector?.('div[translate="no"].notranslate');
    if (examloopBadge?.classList.contains('bg-mainBg')
      && examloopBadge.classList.contains('text-white')) return true;
    for (let cur = el, i = 0; cur && i < 4; i++, cur = cur.parentElement) {
      if (cur.matches?.('[aria-checked="true"], [aria-selected="true"]')) return true;
      if (SELECTED_CLASS_RE.test(String(cur.className || ''))) return true;
    }
    return false;
  }

  function answeredState(type, options, inputs) {
    if (type === 'fill' || type === 'short') return inputs.some((el) => String(el.value || '').trim());
    return options.some(optionSelected);
  }

  function extractChoiceQuestion() {
    const options = optionCandidates();
    if (options.length < 2) return null;
    // 当前题块明确是填空题/主观题时，页面上的零散字母不能当成选项
    const title = currentQuestionTitle();
    if (/填空|主观|简答/.test(title)) return null;
    const root = questionRoot(options);
    const inputs = getInputs(root || document.body);
    const type = detectType(root, options, inputs);
    if (!['single', 'multiple', 'judge'].includes(type)) return null;
    const stem = stripQuestionText(stemSource(root), options);
    if (!stem || stem.length < 4) return null;
    const id = hash(type + '|' + stem + '|' + options.map((o) => o.key + o.text).join('|'));
    return {
      id, type, stem,
      options: options.map(({ key, text, el }) => ({ key, text, el })),
      blanks: 0, answered: answeredState(type, options, inputs),
      root, inputEls: inputs,
    };
  }

  function extractFillQuestion() {
    const all = [...document.querySelectorAll('input, textarea')].filter((el) => {
      if (!visible(el)) return false;
      if (el.type && /^(button|submit|reset|checkbox|radio|file|hidden|search)$/i.test(el.type)) return false;
      if (el.closest('header, #zhs-auto-panel-host')) return false;
      if (el.placeholder && /搜索|请输入搜索|地址/.test(el.placeholder)) return false;
      return true;
    });
    if (!all.length) return null;

    // 先找“题块内带填空/主观题标题”的输入框，避免把其它输入框当成填空题
    let root = null;
    for (const input of all) {
      let cur = input.parentElement;
      for (let i = 0; i < 10 && cur && cur !== document.body; i++, cur = cur.parentElement) {
        if (/(填空题|填空客观题|主观题|简答题)/.test(cur.innerText || '')) { root = cur; break; }
      }
      if (root) break;
    }
    if (!root) {
      // 退化：以“填空 / 主观题”标题附近的容器为准
      const header = [...document.querySelectorAll('body *')].find((el) => {
        const t = (el.innerText || '').trim();
        return visible(el) && /^\d*[.、]?\s*(填空题|填空客观题|主观题|简答题)/.test(t) && t.length < 50;
      });
      root = header ? header.parentElement : all[0].parentElement?.parentElement || document.body;
    }
    const inputs = getInputs(root);
    if (!inputs.length) return null;
    const rootText = root.innerText || '';
    const isFillQuestion = /(填空题|填空客观题|主观题|简答题)/.test(rootText);
    const hasBlankMarker = /_{2,}|[（(]\s*[）)]/.test(rootText);
    if (!isFillQuestion && !hasBlankMarker) return null;
    const stem = stripQuestionText(stemSource(root), []);
    if (!stem) return null;
    const type = /(主观题|简答题)/.test(rootText) || /主观|简答/.test(currentQuestionTitle()) ? 'short' : 'fill';
    const blanks = Math.max(inputs.length, (stem.match(/_{2,}/g) || []).length, 1);
    const id = hash(type + '|' + stem + '|' + blanks);
    return {
      id, type, stem, options: [], blanks,
      answered: inputs.some((el) => String(el.value || '').trim()),
      root, inputEls: inputs,
    };
  }

  function extractQuestion() {
    const fill = extractFillQuestion();
    const choice = extractChoiceQuestion();
    if (fill && choice) {
      // 页面同时能解析出两种题型时，以当前题块标题为准
      const title = currentQuestionTitle();
      if (/填空|主观|简答/.test(title)) return fill;
      if (/单选|多选|判断|单项|多项/.test(title)) return choice;
      const pageText = document.body.innerText || '';
      if (/填空题|主观题|简答题/.test(pageText) && !/单选题|多选题|判断题/.test(pageText)) return fill;
      return choice;
    }
    return choice || fill;
  }

  /* ------------------------------------------------------------------ */
  /* FreeOCS module bridge and answer requests                           */
  /* ------------------------------------------------------------------ */
  async function requestJson(url, payload) {
    const path = new URL(url, location.href).pathname;
    const methods = {
      '/api/agent/command': 'poll',
      '/api/agent/event': 'event',
      '/api/answer': 'answer',
      '/api/health': 'state',
    };
    const method = methods[path];
    if (!method) throw new Error(`不支持的智慧树接口：${path}`);
    const body = { ...(payload || {}) };
    if (method === 'poll') {
      body.client_id = S.agentId;
      body.url = location.href;
      body.title = document.title;
      body.mode = detectMode();
      body.has_content = ['course', 'learn', 'mastery', 'exam', 'result'].includes(body.mode);
    } else if (method === 'answer') {
      body.agent_id = S.agentId;
      body.url = location.href;
    }
    return moduleRequest(method, body);
  }

  const api = (path) => path;

  let statusTimer = 0;
  let lastAgentErrorAt = 0;
  let lastCommandRevision = -1;

  function reportAgentEvent(type, data = {}) {
    if (!S.agentId) return;
    requestJson(api('/api/agent/event'), {
      agent_id: S.agentId,
      type,
      ...data,
      ...(type === 'finished' || type === 'stopped' ? { message: S.status } : {}),
    }).catch((error) => {
      if (now() - lastAgentErrorAt > 30000) {
        lastAgentErrorAt = now();
        console.warn('[ZHS-AUTO] 本机控制台连接失败：' + error.message);
      }
    });
  }

  function updatePanel() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      reportAgentEvent('status', {
        status: {
          running: S.running,
          status: S.status,
          mode: detectMode(),
          url: location.href,
          host: location.host,
          path: location.pathname,
          title: document.title,
          metrics: {
            completedSets: S.completedSets,
            questionsAnswered: S.questionsAnswered,
            errors: S.errors,
            lastLatency: S.lastLatency,
          },
        },
      });
    }, 100);
  }

  async function pollAgentCommand() {
    try {
      const command = await requestJson(
        api(`/api/agent/command?agent_id=${encodeURIComponent(S.agentId)}`),
        null,
        5000,
        'GET',
      );
      S.backendOnline = true;
      S.backendInfo = command;
      applyClickSettings(command.click);
      applyModuleSettings(command.settings);
      CFG.autoSubmit = Boolean(command.auto_submit);
      if (Number.isFinite(command.revision)) S.commandRevision = Number(command.revision);
      const mode = detectMode();
      const supportedPage = ['course', 'learn', 'mastery', 'exam', 'result'].includes(mode);
      if (command.desired_running && command.lease && supportedPage && !S.running && !S.busy
        && command.revision !== lastCommandRevision) {
        lastCommandRevision = command.revision;
        start(true);
      } else if ((!command.desired_running || !command.lease) && S.running) {
        stop(false);
      }
    } catch (error) {
      S.backendOnline = false;
      if (now() - lastAgentErrorAt > 30000) {
        lastAgentErrorAt = now();
        log('本机控制台连接失败：' + error.message, true);
      }
    }
    updatePanel();
  }

  async function askBackend(q) {
    const payload = {
      version: 1,
      requestId: `${now()}-${Math.random().toString(36).slice(2)}`,
      source: 'freeocs-page-agent',
      question: {
        id: q.id, type: q.type, stem: q.stem,
        options: q.options.map(({ key, text }) => ({ key, text })),
        blanks: q.blanks,
        url: location.href, title: document.title,
      },
    };
    const t0 = performance.now();
    const res = await requestJson(api('/api/answer'), payload, CFG.answerTimeoutMs);
    S.lastLatency = Math.round(performance.now() - t0);
    S.questionsAnswered++;
    return normalizeAnswer(q, res);
  }

  async function refreshBackend(silent = true) {
    try {
      const res = await requestJson(api('/api/health'), null, 4500, 'GET');
      S.backendOnline = res?.ok !== false;
      S.backendInfo = res || {};
      applyClickSettings(res?.click || res?.config);
      if (!silent) log('FreeOCS 智慧树模块在线');
    } catch (e) {
      S.backendOnline = false;
      S.backendInfo = { error: e.message };
      if (!silent) log('后端健康检查失败：' + e.message, true);
    }
    updatePanel();
    return S.backendOnline;
  }

  function normalizeAnswer(q, res) {
    let raw = res?.answers ?? res?.answer ?? res?.selected ?? res?.options ?? res?.data?.answers ?? res?.data?.answer;
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
      const hit = raw.find((x) => x && (x.id === q.id || x.questionId === q.id));
      raw = (hit || raw[0])?.answer ?? (hit || raw[0])?.answers;
    }
    if (raw == null) throw new Error('后端响应缺少 answers/answer');

    if (q.type === 'fill' || q.type === 'short') {
      let arr = Array.isArray(raw) ? raw : [raw];
      arr = arr.flatMap((x) => {
        if (Array.isArray(x)) return x;
        if (x && typeof x === 'object') return Object.values(x);
        return [x];
      }).map((x) => String(x ?? '').trim()).filter(Boolean);
      if (!arr.length) throw new Error('后端没有返回填空内容');
      return { kind: 'fill', values: arr };
    }

    let arr = Array.isArray(raw) ? raw : String(raw).split(/[,，;；、\s]+/);
    const keys = [];
    for (const v of arr) {
      const s = String(v ?? '').trim();
      if (!s) continue;
      const km = s.match(/^([A-Ea-e])/);
      if (km) { keys.push(km[1].toUpperCase()); continue; }
      const hit = q.options.find((o) => norm(o.text) === norm(s) || norm(o.text).includes(norm(s)) || norm(s).includes(norm(o.text)));
      if (hit) keys.push(hit.key);
    }
    const unique = [...new Set(keys)].filter((k) => q.options.some((o) => o.key === k));
    if (!unique.length) throw new Error('后端答案无法匹配选项: ' + JSON.stringify(raw));
    if (q.type !== 'multiple' && unique.length > 1) return { kind: 'choice', keys: [unique[0]] };
    return { kind: 'choice', keys: unique };
  }

  async function applyChoice(q, answer) {
    const wanted = new Set(answer.keys);
    for (const opt of q.options) {
      const should = wanted.has(opt.key);
      const selected = optionSelected(opt);
      if (should && !selected) {
        const inp = opt.el.querySelector('input');
        await humanClick(inp || opt.el, `选项 ${opt.key}`);
        await sleep(120);
        if (!optionSelected(opt)) {
          // 有些组件事件绑在父级，逐级补一次
          let cur = opt.el;
          for (let i = 0; i < 3 && cur && !optionSelected(opt); i++, cur = cur.parentElement) {
            await humanClick(cur, `选项 ${opt.key}`);
          }
        }
        if (!optionSelected(opt)) throw new Error(`选项 ${opt.key} 点击后仍未选中`);
      }
      if (!should && selected && q.type !== 'multiple') {
        // 单选/判断若已有旧选择，通常点新选项会自动覆盖，不专门取消
      }
    }
  }

  async function applyFill(q, answer) {
    const inputs = q.inputEls?.length ? q.inputEls : getInputs(q.root || document.body);
    if (!inputs.length) throw new Error('未找到填空输入框');
    let values = answer.values.slice();
    if (inputs.length === 1 && values.length > 1) values = [values.join('；')];
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      const val = values[i] ?? values[values.length - 1] ?? '';
      let applied = false;
      // 有的受控组件会回滚值，写入后校验一次再补一次
      for (let attempt = 0; attempt < 2 && !applied; attempt++) {
        try { el.focus(); } catch {}
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, val); else el.value = val;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
        await sleep(80);
        applied = String(el.value || '').trim() !== '';
      }
      if (!applied) throw new Error(`第 ${i + 1} 个空写入后仍为空`);
    }
  }

  async function goNext(currentId) {
    const btn = findButton('下一题');
    if (!btn) return false;
    if (btn.closest('[disabled], [aria-disabled="true"], .is-disabled, .disabled')) return false;
    await humanClick(btn, '下一题');
    const changed = await waitFor(() => {
      const q = extractQuestion();
      return q && q.id !== currentId ? q : null;
    }, 9000, 300);
    return !!changed;
  }

  async function submitExam() {
    const btn = findButton('提交作业');
    if (!btn) return false;
    const oldConfirm = window.confirm;
    window.confirm = () => true;
    try {
      await humanClick(btn, '提交作业');
      await sleep(600);
      for (let i = 0; i < 10; i++) {
        const ok = findButton('确定') || findButton('确认') || findButton('提交') || findButton('确认提交');
        if (ok) {
          await humanClick(ok, textOf(ok) || '确认提交');
          break;
        }
        await sleep(300);
      }
      await waitFor(() => isResultPage() || /已答对|掌握度|答题结果|暂无数据/.test(document.body.innerText || ''), 15000, 500);
      return isResultPage() || /已答对|掌握度/.test(document.body.innerText || '');
    } finally {
      window.confirm = oldConfirm;
    }
  }

  async function solveExam() {
    S.busy = true;
    setStatus('等待考试题目加载...');
    let processed = 0;
    try {
      for (let i = 0; i < CFG.maxQuestionsPerExam; i++) {
        if (S.stopped) break;
        // 跨域跳转后页面脚本需要重新加载，这里最多等 30 秒
        const q = await waitFor(() => extractQuestion(), CFG.crossDomainWaitMs, 400);
        if (!q) {
          const options = optionCandidates();
          log(`未识别到题目（选项 ${options.length} 个、输入框 ${document.querySelectorAll('input, textarea').length} 个），检查页面是否加载完成`, true);
          setStatus('未识别到题目，已停止');
          reportAgentEvent('stopped');
          break;
        }
        setStatus(`答题中（第 ${i + 1} 题：${q.type}）`);
        if (q.type === 'short' && !CFG.allowShortAnswer) {
          setStatus('主观题已禁用，停止等待人工处理');
          reportAgentEvent('stopped');
          break;
        }
        if (q.answered) {
          log(`第 ${i + 1} 题已有答案，跳过`);
        } else {
          log(`读取第 ${i + 1} 题：${q.type} / ${q.options.length} 个选项 / ${q.blanks} 个空`);
          let answer;
          try {
            answer = await askBackend(q);
          } catch (e) {
            S.lastBackendError = e.message;
            log('后端失败：' + e.message, true);
            setStatus('后端连接失败，已停止');
            S.running = false;
            reportAgentEvent('stopped');
            break;
          }
          if (S.stopped) break;
          log('模型答案：' + (answer.kind === 'choice' ? answer.keys.join(',') : answer.values.join(' | ')));
          try {
            if (answer.kind === 'choice') await applyChoice(q, answer);
            else await applyFill(q, answer);
          } catch (e) {
            S.errors++;
            log('写入答案失败：' + e.message, true);
            setStatus('写入答案失败，已停止');
            S.running = false;
            reportAgentEvent('stopped');
            break;
          }
          await sleep(300);
          processed++;
        }

        const hasNext = await goNext(q.id);
        if (!hasNext) {
          if (!CFG.autoSubmit) {
            setStatus('等待手动提交');
            log('已到提交页；自动提交关闭，等待人工核对', false);
            reportAgentEvent('finished', { message: S.status });
            return false;
          }
          log('已到最后一题，准备提交');
          const ok = await submitExam();
          if (ok) {
            S.completedSets++;
            log(`提交成功，本次累计 ${S.completedSets} 套`);
            setStatus('本套完成');
            await sleep(2000);
            return true;
          }
          log('未能确认提交成功，请在页面检查', true);
          setStatus('提交未确认，已停止');
          reportAgentEvent('stopped');
          return false;
        }
      }
    } finally {
      S.busy = false;
      updatePanel();
    }
    return processed > 0;
  }

  /* ------------------------------------------------------------------ */
  /* 课程巡课                                                           */
  /* ------------------------------------------------------------------ */
  const CARD_LINE_NOISE_RE = /^(掌握度|\d{1,3}\s*%|学习进度.*|知识模块|知识单元|难点|重点|必学|选学|已学完|未开始)$/;

  // 从章节卡片里读掌握度：优先环形进度条的 aria-valuenow，其次“掌握度”附近的百分比
  function cardMastery(el, text) {
    const bar = el.querySelector('.el-progress[aria-valuenow], [role="progressbar"][aria-valuenow]');
    const raw = bar?.getAttribute('aria-valuenow');
    if (raw != null && raw !== '') {
      const value = Number(raw);
      if (Number.isFinite(value)) return Math.max(0, Math.min(100, Math.round(value)));
    }
    const label = el.querySelector('.item-top-right-text');
    if (label && /掌握度/.test(label.textContent || '')) {
      const box = label.parentElement;
      const m = (box?.innerText || '').match(/(\d{1,3})\s*%/);
      if (m) return Number(m[1]);
    }
    // 兜底：取“掌握度”前的百分比
    const hit = String(text).match(/(\d{1,3})\s*%\s*\n?\s*掌握度/);
    return hit ? Number(hit[1]) : null;
  }

  function findChapterCards() {
    const nodes = [...document.querySelectorAll('div, section, article, li')];
    const cards = [];
    for (const el of nodes) {
      if (!laidOut(el)) continue;
      if (el.closest('#zhs-auto-panel-host')) continue;
      const t = el.innerText || '';
      if (t.length < 8 || t.length > 800) continue;
      // 章节卡片一定带“学习进度”；掌握度可能缺失（新知识点还没生成掌握度数据）
      if (!/学习进度/.test(t)) continue;
      if (!/\d{1,3}\s*%/.test(t)) continue;
      // 去掉被子卡片包含的父容器；子元素必须自己也像个章节卡片（有掌握度或标题）
      const childHas = [...el.querySelectorAll('div, section, article, li')].some((c) => {
        const ct = c.innerText || '';
        if (ct.length >= t.length) return false;
        if (!/学习进度/.test(ct) || !/\d{1,3}\s*%/.test(ct)) return false;
        return /掌握度/.test(ct) || !!c.querySelector('.item-title, [class*="item-title"], [class*="card-title"]');
      });
      if (childHas) continue;
      const mastery = cardMastery(el, t);
      const lines = t.split(/\n+/).map((s) => s.trim()).filter(Boolean)
        .filter((s) => !CARD_LINE_NOISE_RE.test(s));
      let title = lines[0] || '';
      if (!title || title.length > 80) continue;
      if (/^\d/.test(title)) {
        const alt = lines.find((s) => s.length > 2 && !/^\d+%$/.test(s));
        if (alt) title = alt;
      }
      if (!title) continue;
      cards.push({
        el,
        title,
        mastery: mastery == null ? 0 : mastery,
        masteryKnown: mastery != null,
      });
    }
    const seen = new Map();
    for (const card of cards) {
      const old = seen.get(card.title);
      // 同一章节可能同时出现在多个模块里，保留掌握度最低的那一份
      if (!old || card.mastery < old.mastery) seen.set(card.title, card);
    }
    return [...seen.values()];
  }

  /* 章节尝试记录（避免“做失败一次就永远跳过”） */
  function progressMap() {
    const v = gmGet(STORE.progress, {});
    return v && typeof v === 'object' ? v : {};
  }

  function chapterRecord(title) {
    const all = progressMap();
    const rec = all[title];
    return rec && typeof rec === 'object' ? rec : {};
  }

  function recordChapter(title, patch) {
    const all = progressMap();
    all[title] = { ...(all[title] && typeof all[title] === 'object' ? all[title] : {}), ...patch, lastAt: now() };
    for (const [k, rec] of Object.entries(all)) {
      if (rec?.lastAt && now() - rec.lastAt > 30 * 86400000) delete all[k];
    }
    gmSet(STORE.progress, all);
  }

  function clearChapter(title) {
    const all = progressMap();
    if (!(title in all)) return;
    delete all[title];
    gmSet(STORE.progress, all);
  }

  // 本轮运行已尝试过的章节（跨子域跳转后仍生效，避免同一轮里重复打开同一章节）
  function runTriedMap(revision) {
    const v = gmGet(STORE.runTried, null);
    if (!v || typeof v !== 'object' || v.revision !== revision) return { revision, items: {} };
    return { revision: v.revision, items: v.items && typeof v.items === 'object' ? v.items : {} };
  }

  function markRunTried(title) {
    const run = runTriedMap(S.commandRevision);
    run.items[title] = now();
    gmSet(STORE.runTried, run);
  }

  function chapterOpened() {
    return isLearnPage() || isMasteryPage() || isExamPage();
  }

  async function openChapter(card) {
    const masteryText = card.masteryKnown ? `掌握度 ${card.mastery}%` : '掌握度未知';
    setStatus('打开章节：' + card.title);
    log(`打开：${card.title}（${masteryText}）`);
    try { card.el.scrollIntoView({ block: 'center' }); } catch {}
    await sleep(250);

    // 依次尝试标题、卡片本体、缩略图/遮罩，任何一种触发跳转即可
    const titleEl = card.el.querySelector('.item-title, [class*="item-title"], h1, h2, h3, h4, h5, h6');
    const thumb = card.el.querySelector('.item-mask, img');
    const targets = [
      titleEl && textOf(titleEl) ? titleEl : null,
      card.el,
      thumb,
    ].filter(Boolean);
    for (let i = 0; i < targets.length; i++) {
      await humanClick(targets[i], `章节 ${card.title}`);
      // 第一次点击给足 SPA 路由时间，后续兜底点击等待短一些
      if (await waitFor(chapterOpened, i === 0 ? 12000 : 6000, 300)) return true;
      if (S.stopped) return false;
    }
    // 双保险：卡片里的“开始学习 / 继续学习 / 去提升”按钮
    const actionBtn = [...card.el.querySelectorAll('button, a, [role="button"], span, div')]
      .filter((el) => visible(el))
      .find((el) => /^(开始学习|去学习|继续学习|开始答题|去提升|立即学习)$/.test(textOf(el)));
    if (actionBtn) {
      await humanClick(actionBtn, textOf(actionBtn));
      if (await waitFor(chapterOpened, 8000, 300)) return true;
    }
    return false;
  }

  async function clickPromote() {
    const btn = await waitFor(() => findButton('去提升', { exact: false }), 12000, 400);
    if (!btn) return false;
    await humanClick(btn, '去提升');
    return true;
  }

  async function enterExamFromChapter() {
    if (!(await waitFor(() => isLearnPage(), 12000, 300))) return false;
    await sleep(700);
    if (!(await clickPromote())) return false;
    if (!(await waitFor(() => isMasteryPage() || isExamPage(), 12000, 300))) return false;
    if (isExamPage()) return true;
    await sleep(500);
    if (!(await clickPromote())) return false;
    return !!(await waitFor(() => isExamPage(), 15000, 300));
  }

  // 折叠起来的章节模块里可能有掌握度 0% 的章节，展开后再扫一次
  async function expandCollapsedSections() {
    // 只处理章节折叠区，避开顶栏/用户菜单/标签栏这些也会带 aria-expanded 的元素
    const notAChapterToggle = (el) => !el
      || /header|tab|user|menu|nav|avatar|dropdown/i.test(String(el.className || ''))
      || !!el.closest('header, nav, [class*="tab-nav"], [class*="user"]');
    const targets = [...document.querySelectorAll(
      '[aria-expanded="false"], .el-collapse-item__header, [class*="collapse-title"], [class*="collapse-header"]',
    )].filter((el) => visible(el) && !el.closest('#zhs-auto-panel-host') && !notAChapterToggle(el));
    const extra = [...document.querySelectorAll('button, span, div')]
      .filter((el) => visible(el) && /^(展开|展开全部|查看更多|显示更多)$/.test(textOf(el)) && !notAChapterToggle(el));
    const list = [...new Set([...targets, ...extra])].slice(0, 10);
    let clicked = 0;
    for (const el of list) {
      if (S.stopped) break;
      await humanClick(el, '展开章节');
      clicked++;
      await sleep(400);
    }
    return clicked;
  }

  function classifyChapterCards(cards) {
    const tried = runTriedMap(S.commandRevision).items;
    const pending = [];
    const skipped = [];
    for (const card of cards) {
      const rec = chapterRecord(card.title);
      const answered = Number(rec.answered) || 0;
      const noTest = Number(rec.noTest) || 0;
      const openFail = Number(rec.openFail) || 0;
      if (card.mastery >= CFG.masteryThreshold) {
        if (card.masteryKnown) clearChapter(card.title);
        continue;
      }
      let reason = '';
      if (answered >= CFG.maxAnswersPerChapter) reason = `已重做 ${answered} 次仍未达标`;
      else if (noTest >= CFG.maxNoTestAttempts) reason = `已 ${noTest} 次没有可用试题`;
      else if (openFail >= CFG.maxOpenFailAttempts) reason = `已 ${openFail} 次打不开章节`;
      else if (tried[card.title]) reason = '本轮已尝试';
      if (reason) {
        skipped.push(`${card.title}（${reason}）`);
        continue;
      }
      pending.push(card);
    }
    return { cards, pending, skipped };
  }

  async function scanCourseChapters() {
    let cards = findChapterCards();
    if (!cards.length) {
      // 有的页面要先切到“掌握度 / 知识学习”标签才渲染章节卡片
      for (const name of ['掌握度', '知识学习', '学习进度']) {
        const tab = findButton(name, { exact: false });
        if (!tab) continue;
        await humanClick(tab, name);
        await sleep(1500);
        cards = findChapterCards();
        if (cards.length) break;
      }
    }
    let result = classifyChapterCards(cards);
    if (!result.pending.length) {
      // 折叠的模块里可能藏着掌握度 0% 的章节，展开后再判定一次
      const expandedCount = await expandCollapsedSections();
      if (expandedCount) {
        await sleep(1200);
        cards = findChapterCards();
        result = classifyChapterCards(cards);
      }
    }
    return result;
  }

  async function courseLoop() {
    if (!isCoursePage() || !S.running) return;
    gmSet(STORE.courseUrl, location.href);
    let { cards, pending, skipped } = await scanCourseChapters();
    log(`课程目录：共识别 ${cards.length} 个章节，待处理 ${pending.length} 个（掌握度 < ${CFG.masteryThreshold}%）`);
    if (skipped.length) log(`暂不处理 ${skipped.length} 个章节：${skipped.slice(0, 5).join('；')}${skipped.length > 5 ? ' …' : ''}`);
    // 刚完成一套回到目录时，页面或成绩数据可能还没刷新出来，多复查几次再判定结束
    const retrySeconds = Math.max(1, Math.round(CFG.emptyPendingRetryMs / 1000));
    for (let attempt = 1; !pending.length && attempt <= CFG.emptyPendingRetries; attempt++) {
      if (S.stopped || !S.running) return;
      setStatus(`未发现待处理章节，${retrySeconds} 秒后复查（${attempt}/${CFG.emptyPendingRetries}）`);
      log(`未发现待处理章节，等待 ${retrySeconds} 秒后复查（${attempt}/${CFG.emptyPendingRetries}）`);
      await sleep(CFG.emptyPendingRetryMs);
      if (S.stopped || !S.running) return;
      ({ cards, pending, skipped } = await scanCourseChapters());
      log(`复查 ${attempt}/${CFG.emptyPendingRetries}：共识别 ${cards.length} 个章节，待处理 ${pending.length} 个`);
    }
    if (!pending.length) {
      log(`复查 ${CFG.emptyPendingRetries} 次后仍没有待处理章节，任务结束`);
      setStatus('全部达到要求');
      S.running = false;
      gmSet(STORE.run, false);
      reportAgentEvent('finished');
      updatePanel();
      return;
    }
    let openFailStreak = 0;
    for (const card of pending.slice(0, CFG.maxChaptersPerRun)) {
      if (S.stopped || !S.running) break;
      markRunTried(card.title);
      const opened = await openChapter(card);
      if (!opened) {
        const rec = chapterRecord(card.title);
        recordChapter(card.title, { openFail: (Number(rec.openFail) || 0) + 1 });
        log(`无法打开 ${card.title}，跳过`, true);
        // 连续多个章节都点不开，说明页面结构变了，先停下来避免空点
        if (++openFailStreak >= 3) {
          log('连续 3 个章节都无法打开，已停止本轮巡课，请检查页面结构', true);
          setStatus('无法打开章节，已停止');
          reportAgentEvent('stopped');
          break;
        }
        continue;
      }
      openFailStreak = 0;
      if (!isLearnPage()) continue;
      setStatus('进入章节：' + card.title);
      const entered = await enterExamFromChapter();
      if (!entered) {
        const rec = chapterRecord(card.title);
        recordChapter(card.title, { noTest: (Number(rec.noTest) || 0) + 1, openFail: 0 });
        log(`${card.title} 没有可作答试题，返回目录`, true);
        await sleep(1200);
        const back = findButton('返回');
        if (back) await humanClick(back, '返回');
        await sleep(1500);
        await navigate(gmGet(STORE.courseUrl, location.href));
        return;
      }
      const rec = chapterRecord(card.title);
      recordChapter(card.title, { answered: (Number(rec.answered) || 0) + 1, noTest: 0, openFail: 0 });
      setStatus('答题中：' + card.title);
      const submitted = await solveExam();
      if (!submitted || S.stopped) return;
      await sleep(1800);
      await navigate(gmGet(STORE.courseUrl, location.href));
      return;
    }
  }

  function detectMode() {
    if (isExamPage()) return 'exam';
    if (isCoursePage()) return 'course';
    if (isLearnPage()) return 'learn';
    if (isMasteryPage()) return 'mastery';
    if (isResultPage()) return 'result';
    return 'other';
  }

  async function start(auto = false) {
    if (S.running || S.busy) return;
    S.running = true;
    S.busy = true;
    S.stopped = false;
    S.hasRun = true;
    S.startedAt = now();
    gmSet(STORE.run, true);
    updatePanel();
    const mode = detectMode();
    log('启动，当前页面：' + mode);
    try {
      if (mode === 'exam') {
        const ok = await solveExam();
        if (ok) {
          const course = gmGet(STORE.courseUrl, '');
          if (course && !S.stopped) {
            log('返回课程目录继续巡课');
            await sleep(1200);
            await navigate(course);
          }
        }
      } else if (mode === 'course') {
        gmSet(STORE.courseUrl, location.href);
        await courseLoop();
      } else if (mode === 'learn') {
        if (await enterExamFromChapter()) await solveExam();
        else {
          log('此章节没有可进入的试题', true);
          reportAgentEvent('stopped');
        }
      } else if (mode === 'mastery') {
        if (await clickPromote()) {
          if (await waitFor(() => isExamPage(), 15000, 300)) await solveExam();
          else reportAgentEvent('stopped');
        } else {
          log('此章节没有可进入的试题', true);
          reportAgentEvent('stopped');
        }
      } else if (mode === 'result') {
        const course = gmGet(STORE.courseUrl, '');
        if (course && !S.stopped) {
          log('成绩页已加载，返回课程目录继续');
          await sleep(1200);
          await navigate(course);
        } else {
          setStatus('成绩页；请从控制台继续');
        }
      } else {
        log('当前页面不是课程/考试页面，请先进入课程目录或考试页', true);
      }
    } catch (e) {
      log('运行异常：' + (e?.message || e), true);
      setStatus('运行异常，已停止');
      reportAgentEvent('stopped');
    } finally {
      S.running = false;
      S.busy = false;
      updatePanel();
    }
  }

  function stop(report = true) {
    S.stopped = true;
    S.running = false;
    gmSet(STORE.run, false);
    setStatus('已停止');
    log('用户停止');
    if (report) reportAgentEvent('stopped');
  }

  /* ------------------------------------------------------------------ */
  /* 后台代理                                                           */
  /* ------------------------------------------------------------------ */
  async function boot() {
    S.agentId = globalThis.crypto?.randomUUID?.()
      || `${now()}-${Math.random().toString(36).slice(2)}`;
    ensurePanel();
    try {
      await loadAgentStore();
    } catch (error) {
      S.backendOnline = false;
      log(`无法读取智慧树跨页面状态：${error.message}`, true);
    }
    // 旧的“7 天内跳过”记录会让失败过的章节再也不进答题，这里直接清掉
    if (gmGet(STORE.legacyVisited, null)) gmSet(STORE.legacyVisited, null);
    const mode = detectMode();
    setStatus(`待启动（${mode}）`);
    if (isCoursePage()) gmSet(STORE.courseUrl, location.href);
    refreshPanel();
    updatePanel();
    await pollAgentCommand();
    setInterval(pollAgentCommand, 1500);
    setInterval(refreshPanel, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }

  // The local dashboard owns configuration and controls; this object exposes page operations only.
  window.__ZHS_AUTO__ = {
    start, stop, extract: extractQuestion, findChapterCards, scanCourseChapters,
    chapterRecord, recordChapter, clearChapter, askBackend,
    refreshBackend, isExamPage, optionCandidates, applyChoice, applyFill, config: CFG, state: S,
  };
})();
