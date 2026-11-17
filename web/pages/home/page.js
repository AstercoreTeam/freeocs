/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

(function () {
  "use strict";

  const OLLAMA_URL = "http://localhost:11434/v1";
  const OLLAMA_MODEL = "qwen2.5vl:7b";
  const SELECTED_SITE_KEY = "freeocs.home.site";
  const MAX_RECORD_SECONDS = 30;
  const RECORD_SCRIPT = "你好，欢迎使用 FreeOCS。我正在用自然、清晰的语气朗读这段话，希望它能代表我的声音。请保持语速平稳，并在安静的环境中录制。";

  function statusLabel(state) {
    if (state && state.running) return "运行中";
    if (state && state.state === "waiting") return "等待操作";
    if (state && state.state === "error") return "错误";
    return "未运行";
  }

  function statusClass(state) {
    if (state && state.running) return "success";
    if (state && state.state === "waiting") return "warning";
    if (state && state.state === "error") return "danger";
    return "";
  }

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  }

  function readSelectedSite() {
    try {
      return window.localStorage.getItem(SELECTED_SITE_KEY) || "";
    } catch (error) {
      return "";
    }
  }

  function writeSelectedSite(siteId) {
    try {
      if (siteId) window.localStorage.setItem(SELECTED_SITE_KEY, siteId);
      else window.localStorage.removeItem(SELECTED_SITE_KEY);
    } catch (error) {
      /* ignore storage failures */
    }
  }

  function encodeBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunk = 0x8000;
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
    }
    return window.btoa(binary);
  }

  function extensionForMime(mime) {
    const value = String(mime || "").toLowerCase();
    if (value.includes("webm")) return "webm";
    if (value.includes("ogg")) return "ogg";
    if (value.includes("mp4") || value.includes("m4a") || value.includes("aac")) return "m4a";
    if (value.includes("wav")) return "wav";
    return "webm";
  }

  function mount(target, initialHome, sections, initialValues, initialVoiceSample) {
    let home = initialHome;
    let values = initialValues;
    let voiceSample = initialVoiceSample;
    let selectedSiteId = readSelectedSite();
    let events = Array.isArray(home.events) ? home.events.slice() : [];
    let polling = false;
    let destroyed = false;

    const sites = home.websites || [];
    if (!sites.some((site) => site.id === selectedSiteId)) selectedSiteId = "";

    let mediaRecorder = null;
    let mediaStream = null;
    let recordChunks = [];
    let recordTimer = 0;
    let recordStartedAt = 0;
    let recordIntent = { save: false };
    let previewUrl = "";

    target.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">首页</h1>
          <p class="page-subtitle">选择网页、准备语音样本和常用配置；其余选项在对应页面中调整。</p>
        </div>
        <div class="home-page-actions">
          <button class="btn btn-sm" data-action="guide">操作指南</button>
        </div>
      </div>

      <section class="card home-section">
        <div class="home-section-head">
          <div>
            <h2 class="card-title">1. 选择要执行的网页</h2>
            <p class="card-subtitle">选择后展开常用配置；详细选项在模块详情和设置页。</p>
          </div>
        </div>
        <div class="home-site-grid" id="home-site-grid"></div>
      </section>

      <div id="home-flow"></div>

      <section class="card home-section home-model-config">
        <div class="home-section-head">
          <div>
            <h2 class="card-title">模型配置</h2>
            <p class="card-subtitle">云端 API 与本地 Ollama 共用 FreeOCS 的模型接口。</p>
          </div>
          <button class="btn btn-sm" data-action="llm-models">下载本地模型</button>
        </div>
        <div class="home-model-grid">
          <div class="form-group">
            <label class="form-label" for="home-llm-mode">连接方式</label>
            <select class="input" id="home-llm-mode">
              <option value="cloud">云端大模型</option>
              <option value="ollama">本地 Ollama</option>
            </select>
          </div>
          <div class="form-group" data-role="api-key-group">
            <label class="form-label" for="home-llm-key">API Key</label>
            <input class="input" id="home-llm-key" type="password" autocomplete="new-password" />
          </div>
          <div class="form-group">
            <label class="form-label" for="home-llm-url">API 地址</label>
            <input class="input" id="home-llm-url" type="url" autocomplete="url" />
          </div>
          <div class="form-group">
            <label class="form-label" for="home-llm-model">模型名称</label>
            <input class="input" id="home-llm-model" type="text" />
          </div>
        </div>
        <p class="form-help" data-role="model-help"></p>
        <div class="home-model-actions">
          <button class="btn btn-primary" data-action="save-model">保存配置</button>
          <button class="btn" data-action="test-model">保存并测试连接</button>
        </div>
      </section>

      <section class="card home-section home-usage-section">
        <div class="home-section-head">
          <div>
            <h2 class="card-title">Token 消耗</h2>
            <p class="card-subtitle">按模型返回的 usage 统计；单价与限额在设置中调整。</p>
          </div>
          <button class="btn btn-sm" data-action="usage-settings">设置单价/限额</button>
        </div>
        <div data-role="usage"></div>
      </section>

      <div class="home-bottom-grid">
        <section class="card home-section">
          <div class="home-section-head">
            <h2 class="card-title">当前状态</h2>
            <button class="btn btn-sm" data-action="refresh">刷新</button>
          </div>
          <div data-role="status"></div>
        </section>
        <section class="card home-section">
          <div class="home-section-head">
            <h2 class="card-title">操作日志</h2>
            <button class="btn btn-sm" data-action="logs">查看全部</button>
          </div>
          <ol class="home-log-list" data-role="logs" aria-live="polite"></ol>
        </section>
      </div>`;

    const siteGrid = target.querySelector("#home-site-grid");
    const flow = target.querySelector("#home-flow");
    const statusRoot = target.querySelector('[data-role="status"]');
    const usageRoot = target.querySelector('[data-role="usage"]');
    const logsRoot = target.querySelector('[data-role="logs"]');

    function siteById(siteId) {
      return sites.find((item) => item.id === siteId) || null;
    }

    function siteModuleId(site) {
      return (site && (site.module_id || site.id)) || "";
    }

    function findModule(site) {
      const moduleId = siteModuleId(site);
      const modules = (home.modules && home.modules.items) || [];
      return modules.find((item) => item.id === moduleId) || null;
    }

    function needsTts(module) {
      return Boolean(
        module && Array.isArray(module.requires) && module.requires.includes("media.tts")
      );
    }

    function pacingSection(site) {
      const section = sections.find((item) => item.id === siteModuleId(site));
      if (!section) return null;
      const fields = (section.fields || []).filter((item) =>
        /(click|interval|jitter)/i.test(item.key || "")
      );
      if (!fields.length) return null;
      return { id: section.id, title: "点击节奏", fields };
    }

    function renderSites() {
      siteGrid.innerHTML = sites.length
        ? sites.map((site) => {
          const module = findModule(site);
          const state = (module && module.state) || {};
          const selected = site.id === selectedSiteId;
          const badges = [
            needsTts(module) ? '<span class="badge primary">语音合成</span>' : "",
            module && module.available === false ? '<span class="badge danger">缺少依赖</span>' : "",
          ].join("");
          return `
            <button type="button" class="home-site-card ${selected ? "is-selected" : ""}"
              data-site="${UI.escapeHtml(site.id)}" aria-pressed="${selected ? "true" : "false"}">
              <span class="home-site-name">${UI.escapeHtml(site.name)}</span>
              <span class="home-site-desc">${UI.escapeHtml(site.description || "")}</span>
              <span class="home-site-meta">
                ${badges}
                <span class="home-site-state ${state.running ? "is-running" : ""}" data-site-state="${UI.escapeHtml(site.id)}">
                  ${UI.escapeHtml(module ? statusLabel(state) : "模块未加载")}
                </span>
              </span>
            </button>`;
        }).join("")
        : UI.empty("暂无可执行的网页");

      siteGrid.querySelectorAll("[data-site]").forEach((button) => {
        button.addEventListener("click", () => {
          const siteId = button.dataset.site;
          if (siteId === selectedSiteId) return;
          selectedSiteId = siteId;
          writeSelectedSite(siteId);
          renderSites();
          renderFlow();
        });
      });
    }

    function renderStatusCards() {
      const bridge = home.bridge || {};
      const llm = home.llm || {};
      const modules = (home.modules && home.modules.items) || [];
      const running = modules.filter((item) => item.state && item.state.running).length;
      const mode = llm.provider_mode === "ollama" ? "本地 Ollama" : "云端大模型";
      statusRoot.innerHTML = `
        <div class="home-status-grid">
          <article class="home-status-card">
            <span class="home-status-label">自动化模块</span>
            <strong>${running} / ${modules.length}</strong>
            <span class="home-status-detail">正在运行 / 已加载</span>
          </article>
          <article class="home-status-card">
            <span class="home-status-label">浏览器扩展</span>
            <strong class="${bridge.connected ? "home-state-ok" : ""}">${bridge.connected ? "已连接" : "未连接"}</strong>
            <span class="home-status-detail">${UI.escapeHtml(bridge.server || "等待扩展连接")}</span>
          </article>
          <article class="home-status-card">
            <span class="home-status-label">大模型</span>
            <strong class="${llm.configured ? "home-state-ok" : "home-state-warn"}">${llm.configured ? "已配置" : "未配置"}</strong>
            <span class="home-status-detail">${UI.escapeHtml(`${mode} · ${llm.model || "未选择模型"}`)}</span>
          </article>
        </div>`;
    }

    function renderLogs() {
      const recent = events.slice()
        .sort((a, b) => Number(b.seq || 0) - Number(a.seq || 0))
        .slice(0, 8);
      logsRoot.innerHTML = recent.length ? recent.map((event) => {
        const level = ["error", "warn", "warning", "debug"].includes(event.level)
          ? event.level
          : "info";
        return `
          <li class="home-log-row">
            <time>${UI.escapeHtml(UI.formatDateTime(event.ts))}</time>
            <span class="home-log-level level-${level}">${UI.escapeHtml(event.level || "info")}</span>
            <span class="home-log-source">${UI.escapeHtml(event.package || event.type || "FreeOCS")}</span>
            <span class="home-log-message">${UI.escapeHtml(event.message || "")}</span>
          </li>`;
      }).join("") : '<li class="form-help">暂无操作日志。</li>';
    }

    function updateSiteStates() {
      sites.forEach((site) => {
        const element = siteGrid.querySelector(`[data-site-state="${CSS.escape(site.id)}"]`);
        if (!element) return;
        const module = findModule(site);
        const state = (module && module.state) || {};
        element.textContent = module ? statusLabel(state) : "模块未加载";
        element.classList.toggle("is-running", Boolean(state.running));
      });
      updateFlowState();
    }

    function updateFlowState() {
      const statusElement = flow.querySelector('[data-role="module-status"]');
      if (!statusElement || !selectedSiteId) return;
      const site = siteById(selectedSiteId);
      const module = site ? findModule(site) : null;
      const state = (module && module.state) || {};
      if (!module) {
        statusElement.innerHTML = '<span class="badge danger">模块未加载</span> 请到“应用与插件”检查模块状态。';
      } else {
        statusElement.innerHTML = `<span class="badge ${statusClass(state)}">${UI.escapeHtml(statusLabel(state))}</span> ${UI.escapeHtml(state.message || "")}`;
      }
      const start = flow.querySelector('[data-action="start"]');
      const stop = flow.querySelector('[data-action="stop"]');
      if (start) start.disabled = !module || module.available === false || Boolean(state.running);
      if (stop) stop.disabled = !module || !state.running;
    }

    function ttsField() {
      const section = sections.find((item) => item.id === "capabilities");
      return ((section && section.fields) || []).find((field) => field.key === "media.tts") || null;
    }

    function ttsProvider() {
      const field = ttsField();
      const saved = values.capabilities && values.capabilities["media.tts"];
      if (saved) return saved;
      if (field && field.default) return field.default;
      const first = field && field.options && field.options[0];
      return first ? first.value : "";
    }

    function ttsProviderLabel() {
      const provider = ttsProvider();
      const field = ttsField();
      const option = ((field && field.options) || []).find((item) => item.value === provider);
      return option ? (option.label || provider) : (provider || "未绑定");
    }

    function renderVoiceSample() {
      const element = flow.querySelector('[data-role="voice-current"]');
      if (!element) return;
      if (voiceSample && voiceSample.exists) {
        element.innerHTML = `
          <span class="badge success">已设置</span>
          <span class="home-voice-name">${UI.escapeHtml(voiceSample.name || "")}</span>
          <span class="form-help">${UI.escapeHtml(formatBytes(voiceSample.size))}</span>`;
        element.title = voiceSample.path || "";
      } else if (voiceSample && voiceSample.path) {
        element.innerHTML = `<span class="badge warning">文件不存在</span><span class="form-help">${UI.escapeHtml(voiceSample.path)}</span>`;
        element.title = voiceSample.path;
      } else {
        element.innerHTML = '<span class="badge">未设置</span>';
        element.title = "";
      }
    }

    function setRecorderStatus(text) {
      const element = flow.querySelector('[data-role="recorder-status"]');
      if (element) element.textContent = text || "";
    }

    function updateRecorderTimer() {
      const element = flow.querySelector('[data-role="recorder-timer"]');
      if (!element) return;
      const seconds = Math.max(0, Math.floor((Date.now() - recordStartedAt) / 1000));
      element.textContent = `00:${String(seconds).padStart(2, "0")}`;
    }

    function stopMediaStream() {
      if (mediaStream) {
        mediaStream.getTracks().forEach((track) => track.stop());
        mediaStream = null;
      }
    }

    function resetRecorder() {
      if (recordTimer) {
        window.clearInterval(recordTimer);
        recordTimer = 0;
      }
      recordIntent = { save: false };
      stopMediaStream();
      mediaRecorder = null;
      recordChunks = [];
    }

    async function finishRecording(chunks, mimeType, intent) {
      resetRecorder();
      const start = flow.querySelector('[data-action="record-start"]');
      const stop = flow.querySelector('[data-action="record-stop"]');
      if (start) start.disabled = false;
      if (stop) stop.disabled = true;
      if (!intent.save) {
        setRecorderStatus("");
        return;
      }
      const blob = new Blob(chunks, { type: mimeType || "audio/webm" });
      if (!blob.size) {
        setRecorderStatus("没有录到声音，请重试。");
        return;
      }
      setRecorderStatus(`正在保存 ${formatBytes(blob.size)}…`);
      try {
        const base64 = encodeBase64(await blob.arrayBuffer());
        const result = await API.must("save_voice_sample", extensionForMime(mimeType), base64);
        voiceSample = result.sample || {};
        values.tts_kokoclone = Object.assign({}, values.tts_kokoclone, {
          reference_audio: voiceSample.path || "",
        });
        renderVoiceSample();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = URL.createObjectURL(blob);
        const audio = flow.querySelector('[data-role="voice-preview"]');
        if (audio) {
          audio.src = previewUrl;
          audio.hidden = false;
        }
        setRecorderStatus("已保存，可试听或重新录制。");
        UI.toast("参考音频已保存", "success");
      } catch (error) {
        setRecorderStatus(error.message || "保存录音失败");
        UI.toast(error.message || "保存录音失败", "error", 6000);
      }
    }

    function stopRecording(save) {
      if (!mediaRecorder) return;
      recordIntent = { save };
      try {
        mediaRecorder.stop();
      } catch (error) {
        resetRecorder();
      }
    }

    async function startRecording() {
      if (mediaRecorder) return;
      if (
        !navigator.mediaDevices ||
        typeof navigator.mediaDevices.getUserMedia !== "function" ||
        typeof window.MediaRecorder !== "function"
      ) {
        UI.toast("当前浏览器不支持录音，请改用上传音频文件", "error", 6000);
        return;
      }
      const start = flow.querySelector('[data-action="record-start"]');
      const stop = flow.querySelector('[data-action="record-stop"]');
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (error) {
        UI.toast("无法使用麦克风：" + (error.message || error), "error", 6000);
        return;
      }
      const candidates = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
        "audio/ogg;codecs=opus",
      ];
      const mimeType = candidates.find((type) =>
        typeof window.MediaRecorder.isTypeSupported === "function" &&
        window.MediaRecorder.isTypeSupported(type)
      ) || "";
      try {
        const recorder = mimeType
          ? new window.MediaRecorder(mediaStream, { mimeType })
          : new window.MediaRecorder(mediaStream);
        mediaRecorder = recorder;
        recordChunks = [];
        recorder.addEventListener("dataavailable", (event) => {
          if (event.data && event.data.size) recordChunks.push(event.data);
        });
        recorder.addEventListener("stop", () => {
          void finishRecording(recordChunks.slice(), recorder.mimeType || mimeType, recordIntent);
        });
        recorder.start();
      } catch (error) {
        resetRecorder();
        UI.toast("无法开始录音：" + (error.message || error), "error", 6000);
        return;
      }
      recordStartedAt = Date.now();
      updateRecorderTimer();
      setRecorderStatus("正在录音，请朗读上面的示例。");
      if (start) start.disabled = true;
      if (stop) stop.disabled = false;
      recordTimer = window.setInterval(() => {
        updateRecorderTimer();
        if (Date.now() - recordStartedAt >= MAX_RECORD_SECONDS * 1000) {
          setRecorderStatus("已达到最长录音时间，正在保存…");
          stopRecording(true);
        }
      }, 500);
    }

    function renderFlow() {
      resetRecorder();
      const site = siteById(selectedSiteId);
      if (!site) {
        flow.innerHTML = '<section class="card home-section"><p class="form-help">请选择要执行的网页。</p></section>';
        return;
      }
      const module = findModule(site);
      const state = (module && module.state) || {};
      const pacing = pacingSection(site);
      const provider = ttsProvider();
      const clone = provider === "tts_kokoclone";
      const ttsHtml = needsTts(module) ? `
        <section class="card home-section">
          <div class="home-section-head">
            <div>
              <h2 class="card-title">3. 语音样本</h2>
              <p class="card-subtitle">${UI.escapeHtml(site.name)}需要语音合成；当前提供者：${UI.escapeHtml(ttsProviderLabel())}。</p>
            </div>
            <div class="home-flow-actions">
              <button class="btn btn-sm" data-action="models">模型下载</button>
              <button class="btn btn-sm btn-ghost" data-action="tts-settings">语音设置</button>
            </div>
          </div>
          ${clone ? `
          <div class="home-voice" data-role="voice-panel">
            <div class="home-voice-head">
              <strong>样本音频</strong>
              <span class="home-voice-current" data-role="voice-current"></span>
            </div>
            <p class="form-help">用于克隆音色：3–10 秒、单人、无背景音乐的清晰人声。可以直接上传音频，也可以朗读下面的示例。</p>
            <div class="home-voice-actions">
              <button class="btn btn-sm" data-action="voice-upload">上传音频文件</button>
              <button class="btn btn-sm" data-action="voice-record">朗读示例并录制</button>
              <button class="btn btn-sm btn-ghost" data-action="voice-clear">清除</button>
            </div>
            <div class="home-voice-recorder" data-role="recorder" hidden>
              <blockquote class="home-voice-script">${UI.escapeHtml(RECORD_SCRIPT)}</blockquote>
              <div class="home-voice-recorder-row">
                <button class="btn btn-primary btn-sm" data-action="record-start">开始录音</button>
                <button class="btn btn-sm" data-action="record-stop" disabled>停止并保存</button>
                <span class="home-voice-timer" data-role="recorder-timer">00:00</span>
                <span class="form-help" data-role="recorder-status"></span>
              </div>
              <audio data-role="voice-preview" controls hidden></audio>
            </div>
          </div>` : `
          <p class="form-help">
            当前语音提供者不是克隆语音，样本音频暂不生效。请到“设置 → 能力绑定”选择 KokoClone 克隆语音。
          </p>`}
          <p class="form-help home-model-hint">
            模型下载：左侧“模型下载”页面可下载 Kokoro / Kanade 语音模型，也可拉取 Ollama 模型（推荐 qwen2.5vl:7b）。
            语言、模型文件、单次合成上限等详细选项在“设置 → 克隆语音（KokoClone）”。
          </p>
        </section>` : "";

      flow.innerHTML = `
        <section class="card home-section">
          <div class="home-flow-head">
            <div>
              <h2 class="card-title">2. ${UI.escapeHtml(site.name)} 操作</h2>
              <p class="card-subtitle">${UI.escapeHtml((module && module.description) || site.description || "")}</p>
            </div>
            <div class="home-flow-actions">
              <button class="btn btn-primary" data-action="launch">打开 ${UI.escapeHtml(site.name)}</button>
              <button class="btn" data-action="start" ${!module || module.available === false || state.running ? "disabled" : ""}>启动模块</button>
              <button class="btn" data-action="stop" ${!module || !state.running ? "disabled" : ""}>停止</button>
              <button class="btn btn-sm" data-action="details" ${module ? "" : "disabled"}>模块详情</button>
              <button class="btn btn-sm btn-ghost" data-action="module-settings" ${module ? "" : "disabled"}>更多配置</button>
            </div>
          </div>
          <p class="home-flow-status" data-role="module-status"></p>
          ${pacing
            ? '<div class="home-pacing" data-role="pacing"></div>'
            : '<p class="form-help">该网页没有可调的操作节奏；其他选项见“模块详情”或“设置”。</p>'}
        </section>
        ${ttsHtml}`;

      if (pacing) {
        SettingsUI.renderSections(flow.querySelector('[data-role="pacing"]'), [pacing], values, reloadValues);
      }

      updateFlowState();
      renderVoiceSample();
      bindFlow(site, module);
    }

    async function reloadValues() {
      try {
        const result = await API.must("get_settings_values");
        values = result.values || {};
      } catch (error) {
        UI.toast(error.message || "无法刷新设置", "error");
      }
    }

    function bindFlow(site, module) {
      flow.querySelector('[data-action="launch"]').addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          const result = await API.must("launch_supported_website", site.id);
          UI.toast(`已在 ${result.browser} 新窗口打开 ${result.site}`, "success");
        } catch (error) {
          UI.toast(error.message || "无法打开网页", "error", 6000);
        } finally {
          button.disabled = false;
        }
      });

      flow.querySelector('[data-action="start"]').addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await API.must("module_start", siteModuleId(site));
          UI.toast("模块已启动", "success");
          await refreshHome();
        } catch (error) {
          UI.toast(error.message || "无法启动模块", "error", 6000);
        } finally {
          updateFlowState();
        }
      });

      flow.querySelector('[data-action="stop"]').addEventListener("click", async (event) => {
        const button = event.currentTarget;
        button.disabled = true;
        try {
          await API.must("module_stop", siteModuleId(site));
          UI.toast("模块已停止", "success");
          await refreshHome();
        } catch (error) {
          UI.toast(error.message || "无法停止模块", "error", 6000);
        } finally {
          updateFlowState();
        }
      });

      const details = flow.querySelector('[data-action="details"]');
      if (details) {
        details.addEventListener("click", () => App.navigate("module", { id: siteModuleId(site) }));
      }

      const moduleSettings = flow.querySelector('[data-action="module-settings"]');
      if (moduleSettings) {
        moduleSettings.addEventListener("click", () =>
          App.navigate("settings", { section: siteModuleId(site) })
        );
      }

      const models = flow.querySelector('[data-action="models"]');
      if (models) models.addEventListener("click", () => App.navigate("models"));

      const ttsSettings = flow.querySelector('[data-action="tts-settings"]');
      if (ttsSettings) {
        ttsSettings.addEventListener("click", () =>
          App.navigate("settings", { section: "tts_kokoclone" })
        );
      }

      const upload = flow.querySelector('[data-action="voice-upload"]');
      if (upload) {
        upload.addEventListener("click", async () => {
          upload.disabled = true;
          try {
            const result = await API.must("import_voice_sample");
            if (result.cancelled) return;
            voiceSample = result.sample || {};
            values.tts_kokoclone = Object.assign({}, values.tts_kokoclone, {
              reference_audio: voiceSample.path || "",
            });
            renderVoiceSample();
            UI.toast("参考音频已导入", "success");
          } catch (error) {
            UI.toast(error.message || "无法导入音频", "error", 6000);
          } finally {
            upload.disabled = false;
          }
        });
      }

      const recordToggle = flow.querySelector('[data-action="voice-record"]');
      const recorderPanel = flow.querySelector('[data-role="recorder"]');
      if (recordToggle && recorderPanel) {
        recordToggle.addEventListener("click", () => {
          recorderPanel.hidden = false;
          const start = recorderPanel.querySelector('[data-action="record-start"]');
          if (start) start.focus();
        });
      }

      const recordStart = flow.querySelector('[data-action="record-start"]');
      if (recordStart) recordStart.addEventListener("click", () => void startRecording());
      const recordStop = flow.querySelector('[data-action="record-stop"]');
      if (recordStop) recordStop.addEventListener("click", () => stopRecording(true));

      const clear = flow.querySelector('[data-action="voice-clear"]');
      if (clear) {
        clear.addEventListener("click", async () => {
          const confirmed = await UI.modal({
            title: "清除参考音频",
            message: "清除后克隆语音将无法使用，直到重新上传或录制。",
            confirmText: "清除",
            danger: true,
          });
          if (!confirmed) return;
          try {
            const result = await API.must("clear_voice_sample");
            voiceSample = result.sample || {};
            values.tts_kokoclone = Object.assign({}, values.tts_kokoclone, { reference_audio: "" });
            renderVoiceSample();
            UI.toast("已清除参考音频", "success");
          } catch (error) {
            UI.toast(error.message || "无法清除参考音频", "error");
          }
        });
      }
    }

    function setupLlm() {
      const llm = values.llm || {};
      let hasKey = Boolean(llm.__has_value && llm.__has_value.api_key);
      const currentMode = llm.provider_mode === "ollama" ? "ollama" : "cloud";
      const profiles = {
        cloud: {
          baseUrl: currentMode === "cloud" ? (llm.base_url || "https://api.deepseek.com") : "https://api.deepseek.com",
          model: currentMode === "cloud" ? (llm.model || "deepseek-flash") : "deepseek-flash",
        },
        ollama: {
          baseUrl: currentMode === "ollama" ? (llm.base_url || OLLAMA_URL) : OLLAMA_URL,
          model: currentMode === "ollama" ? (llm.model || OLLAMA_MODEL) : OLLAMA_MODEL,
        },
      };
      let activeMode = currentMode;
      let busy = false;

      const modeInput = target.querySelector("#home-llm-mode");
      const keyInput = target.querySelector("#home-llm-key");
      const keyGroup = target.querySelector('[data-role="api-key-group"]');
      const urlInput = target.querySelector("#home-llm-url");
      const modelInput = target.querySelector("#home-llm-model");
      const modelHelp = target.querySelector('[data-role="model-help"]');
      const saveButton = target.querySelector('[data-action="save-model"]');
      const testButton = target.querySelector('[data-action="test-model"]');

      function renderMode() {
        const ollama = modeInput.value === "ollama";
        keyGroup.hidden = ollama;
        keyInput.placeholder = hasKey ? "已配置；留空可保留现有 Key" : "云端服务 API Key";
        modelHelp.textContent = ollama
          ? `请先启动 Ollama。推荐模型：${OLLAMA_MODEL}；点击“下载本地模型”可拉取。`
          : "填写云端 OpenAI 兼容 API 地址、模型名称和 API Key。";
      }

      modeInput.value = currentMode;
      urlInput.value = profiles[currentMode].baseUrl;
      modelInput.value = profiles[currentMode].model;
      renderMode();

      modeInput.addEventListener("change", () => {
        profiles[activeMode] = { baseUrl: urlInput.value, model: modelInput.value };
        activeMode = modeInput.value;
        urlInput.value = profiles[activeMode].baseUrl;
        modelInput.value = profiles[activeMode].model;
        renderMode();
      });

      target.querySelector('[data-action="llm-models"]').addEventListener("click", () => App.navigate("models"));

      async function saveModel(test) {
        if (busy) return;
        busy = true;
        saveButton.disabled = true;
        testButton.disabled = true;
        const originalLabel = testButton.textContent;
        if (test) testButton.textContent = "测试中…";
        try {
          const saveValues = {
            provider_mode: modeInput.value,
            base_url: urlInput.value.trim(),
            model: modelInput.value.trim(),
            api_key: modeInput.value === "ollama" ? null : keyInput.value,
          };
          await API.must("save_settings", "llm", saveValues);
          hasKey = modeInput.value !== "ollama" && (hasKey || Boolean(saveValues.api_key));
          keyInput.value = "";
          renderMode();
          await App.reloadBootstrap();
          if (test) {
            const result = await API.must("test_llm");
            UI.toast(`连接成功：${result.model || modelInput.value}（${result.latency_ms || 0} ms）`, "success");
          } else {
            UI.toast("大模型配置已保存", "success");
          }
          await refreshHome();
        } catch (error) {
          UI.toast(error.message || "大模型操作失败", "error", 6000);
        } finally {
          busy = false;
          saveButton.disabled = false;
          testButton.disabled = false;
          testButton.textContent = originalLabel;
        }
      }

      saveButton.addEventListener("click", () => void saveModel(false));
      testButton.addEventListener("click", () => void saveModel(true));
    }

    function renderUsage() {
      if (!usageRoot) return;
      const u = home.usage || {};
      const limit = Number(u.monthly_limit || 0);
      const used = Number(u.month_cost || 0);
      const remaining = Number(u.remaining || 0);
      const progress = limit > 0 ? Math.min(100, Math.max(0, (used / limit) * 100)) : 0;
      const prices = [
        ["命中", u.cache_hit_price_per_million || 0],
        ["未命中", u.cache_miss_price_per_million || 0],
        ["输出", u.output_price_per_million || 0],
      ];
      usageRoot.innerHTML = `
        <div class="home-usage-grid">
          <div class="home-usage-main">
            <span class="home-usage-label">本月 Token</span>
            <strong>${Number(u.month_tokens || 0).toLocaleString()}</strong>
            <span class="form-help">${Number(u.month_calls || 0)} 次调用</span>
          </div>
          <div class="home-usage-main">
            <span class="home-usage-label">本月消费</span>
            <strong>¥${used.toFixed(3)}</strong>
            <span class="form-help">累计 ¥${Number(u.total_cost || 0).toFixed(3)}</span>
          </div>
          <div class="home-usage-main">
            <span class="home-usage-label">月度限额</span>
            <strong>${limit > 0 ? `¥${limit.toFixed(2)}` : "未设置"}</strong>
            <span class="form-help">${limit > 0 ? `剩余 ¥${remaining.toFixed(2)}` : "达到限额后阻止新调用"}</span>
          </div>
          <div class="home-usage-prices">
            ${prices.map(([label, value]) =>
              `<span>${label} <b>¥${Number(value).toFixed(4)}</b>/百万</span>`
            ).join("")}
          </div>
        </div>
        <div class="home-usage-progress" title="${limit > 0 ? `${progress.toFixed(1)}%` : "未设置限额"}">
          <span style="width:${progress}%"></span>
        </div>`;
    }

    async function refreshHome() {
      try {
        home = await API.must("get_home");
        const latestEvents = Array.isArray(home.events) ? home.events : [];
        if (latestEvents.length) {
          const bySeq = new Map(events.map((item) => [item.seq, item]));
          latestEvents.forEach((item) => bySeq.set(item.seq, item));
          events = Array.from(bySeq.values()).sort((a, b) => Number(a.seq || 0) - Number(b.seq || 0)).slice(-30);
          renderLogs();
        }
        updateSiteStates();
        renderStatusCards();
        renderUsage();
      } catch (error) {
        console.warn("刷新首页状态失败", error);
      }
    }

    function onEvents(event) {
      const incoming = Array.isArray(event.detail) ? event.detail : [];
      const seqs = new Set(events.map((item) => item.seq));
      for (const item of incoming) {
        if (!seqs.has(item.seq)) events.push(item);
      }
      events = events.slice(-30);
      renderLogs();
    }

    target.querySelector('[data-action="guide"]').addEventListener("click", () => App.navigate("guide"));
    target.querySelector('[data-action="usage-settings"]').addEventListener("click", () => App.navigate("settings", { section: "usage" }));
    target.querySelector('[data-action="refresh"]').addEventListener("click", () => void refreshHome());
    target.querySelector('[data-action="logs"]').addEventListener("click", () => App.navigate("logs"));

    renderSites();
    renderFlow();
    setupLlm();
    renderStatusCards();
    renderUsage();
    renderLogs();
    document.addEventListener("focs:events", onEvents);

    const timer = window.setInterval(async () => {
      if (destroyed || polling || document.hidden) return;
      polling = true;
      try {
        await refreshHome();
      } finally {
        polling = false;
      }
    }, 3000);

    return {
      destroy() {
        destroyed = true;
        window.clearInterval(timer);
        document.removeEventListener("focs:events", onEvents);
        resetRecorder();
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = "";
      },
    };
  }

  window.definePage("home", {
    async init(params, root) {
      const target = root.querySelector("#home-root") || root;
      target.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在读取首页…</div>';
      try {
        const [home, schema, settings, voice] = await Promise.all([
          API.must("get_home"),
          API.must("get_settings_schema"),
          API.must("get_settings_values"),
          API.must("get_voice_sample"),
        ]);
        return mount(
          target,
          home,
          schema.sections || [],
          settings.values || {},
          voice.sample || {}
        );
      } catch (error) {
        target.innerHTML = `<div class="card">${UI.empty(error.message || "无法读取首页", "!")}</div>`;
        return { destroy: () => {} };
      }
    },
  });
})();
