/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

(function () {
  "use strict";

  if (globalThis.__freeocs_ucampus_loaded__) return;
  globalThis.__freeocs_ucampus_loaded__ = true;
  try { document.documentElement.dataset.freeocsUcampus = "1"; } catch (error) {}
  try {
    window.addEventListener("error", (event) => {
      document.documentElement.dataset.freeocsAgentError =
        `${event.message || "error"} @ ${event.filename || ""}:${event.lineno || 0}`;
    });
    window.addEventListener("unhandledrejection", (event) => {
      document.documentElement.dataset.freeocsAgentError =
        `unhandled: ${event.reason && (event.reason.stack || event.reason.message) || event.reason}`;
    });
  } catch (_) {
    // Ignore diagnostic failures.
  }

  // The portal tab also matches *.unipus.cn, but it must not compete with the
  // course tab for the single automation client slot.
  if (location.hostname === "ucloud.unipus.cn") return;

  const RUN_STATE_KEY = "ucampusAssistantRunState";
  const COURSE_START_KEY = "ucampusAssistantPendingCourseStart";
  function gmGet(key, fallback) {
    try {
      const raw = localStorage.getItem(`freeocs:ucampus:${key}`);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function gmSet(key, value) {
    try {
      const storageKey = `freeocs:ucampus:${key}`;
      if (value === null || value === undefined) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (_) {
      // localStorage may be unavailable in private mode.
    }
  }

  const SUBMIT_HANDOFF_KEY = "ucampusAssistantSubmitHandoff";
  const CLIENT_ID_KEY = "ucampusAssistantClientId";
  const CLIENT_ID = gmGet(CLIENT_ID_KEY, "") || (() => {
    const id = `ucampus-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    gmSet(CLIENT_ID_KEY, id);
    return id;
  })();
  let audioBlob = null;
  let automationRunning = false;
  let pendingNavigation = false;
  let actionAdvanced = false;
  const submittedSteps = new Set();
  let automationIntro = "";
  let courseStartAttempted = false;
  let controllerPolling = false;
  let manualStop = false;
  let runHalted = false;
  let submitHandoff = null;
  let submitWatcherRunning = false;
  let panelAnswer = "";
  let panelAnswerLabel = "";
  let panelAnswerUrl = "";
  let backendConnected = false;
  let currentStatus = "已连接，等待控制台";
  let runState = loadRunState();
  let autoSubmitEnabled = gmGet("ucaAutoSubmit", false) === true;
  const submittedDiscussionKeys = new Set(
    (gmGet("ucaDiscussionSubmitKeys", []) || []).filter((item) => typeof item === "string")
  );
  const moduleSettings = { autoRecordSpeaking: true };

  function applyAgentSettings(settings) {
    if (!settings || typeof settings !== "object") return;
    if ("auto_record_speaking" in settings) {
      moduleSettings.autoRecordSpeaking = settings.auto_record_speaking !== false;
    }
  }

  function loadRunState() {
    const saved = gmGet(RUN_STATE_KEY, {});
    return {
      completed: Number.isInteger(saved.completed) ? saved.completed : 0,
      entries: Array.isArray(saved.entries) ? saved.entries.slice(-12) : [],
    };
  }

  function updateRunLog(message, type = "info", countAnswer = false) {
    if (countAnswer) runState.completed += 1;
    runState.entries.push({
      time: new Date().toLocaleTimeString(),
      message,
      type,
    });
    runState.entries = runState.entries.slice(-12);
    gmSet(RUN_STATE_KEY, runState);
    renderRunLog();
    void request("/api/automation/log", {
      message,
      level: type,
      page_url: location.href,
      page_title: document.title,
    }).catch((error) => console.warn("[UCampus Assistant] 无法同步执行日志", error));
  }

  function renderRunLog() {
    const host = document.getElementById("freeocs-ucampus-panel");
    if (!host) return;
    const list = host.querySelector('[data-foc="run-log"]');
    if (!list) return;
    const entries = runState.entries.slice(-8);
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("div");
      empty.className = "foc-log-empty";
      empty.textContent = "暂无执行日志";
      list.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const row = document.createElement("div");
      row.className = `foc-log-row ${entry.type || "info"}`;
      const time = document.createElement("span");
      time.className = "foc-log-time";
      time.textContent = entry.time || "";
      const message = document.createElement("span");
      message.className = "foc-log-message";
      message.textContent = entry.message || "";
      row.append(time, message);
      list.appendChild(row);
    }
    list.scrollTop = list.scrollHeight;
  }

  function modulePath(path) {
    const map = {
      "/api/answer": "/api/module/ucampus/answer",
      "/api/transcribe": "/api/module/ucampus/transcribe",
      "/api/transcribe-url": "/api/module/ucampus/transcribe-url",
      "/api/speech": "/api/module/ucampus/tts",
      "/api/listen": "/api/module/ucampus/listen",
    };
    if (map[path]) return map[path];
    if (path.startsWith("/api/automation/")) {
      return `/api/module/ucampus/${path.slice("/api/automation/".length)}`;
    }
    return path;
  }

  function base64ToBlob(base64, mime) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return new Blob([bytes], { type: mime || "application/octet-stream" });
  }

  async function request(path, body, responseType = "json") {
    try {
      const response = await __freeocs.request(modulePath(path), {
        method: "POST",
        body: body || {},
      });
      if (responseType === "blob") {
        if (!response || !response.audio_base64) throw new Error("语音合成未返回音频");
        return base64ToBlob(response.audio_base64, response.mime || "audio/mpeg");
      }
      return response;
    } catch (error) {
      throw new Error(error && error.message ? error.message : String(error));
    }
  }

  function visible(element) {
    return Boolean(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
  }

  function controlVisible(element) {
    return visible(element) || [...(element.labels || [])].some(visible) ||
      visible(element.closest("label"));
  }

  function visibleDocument(doc) {
    if (!doc || doc === document) return true;
    try {
      const frame = doc.defaultView?.frameElement;
      if (!frame || frame.closest("#freeocs-ucampus-panel, #uca-panel")) return false;
      return visible(frame);
    } catch (_) {
      return false;
    }
  }

  function pageDocuments() {
    const docs = [document];
    for (let index = 0; index < docs.length; index += 1) {
      const root = docs[index];
      for (const element of root.querySelectorAll("*")) {
        if (element.shadowRoot && !docs.includes(element.shadowRoot)) {
          docs.push(element.shadowRoot);
        }
        if (element.tagName !== "IFRAME") continue;
        try {
          if (element.contentDocument?.body && !docs.includes(element.contentDocument)) {
            docs.push(element.contentDocument);
          }
        } catch (_) {
          // Cross-origin frames run their own page-agent instance.
        }
      }
    }
    return docs;
  }

  const AUDIO_TRANSCRIPT_CACHE = new Map();
  const PAGE_TRANSCRIPT_CACHE = new Map();
  const VIDEO_TRANSCRIPT_CACHE = new Map();

  const PLAYER_TEXT_RE = /(?:Video Player is loading\.?|Current Time\s*[\d:]+|Duration\s*[\d:]+(?:\/[\d:]+)?|Loaded:\s*[\d.]+%|Stream Type\s*LIVE|Remaining Time\s*-?[\d:]+|\d+(?:\.\d+)?x\s*Chapters|descriptions (?:off|on), selected|subtitles (?:off|on), selected|This is a modal window\.?|倍速)/gi;

  function cleanQuestionText(value) {
    return String(value || "")
      .replace(PLAYER_TEXT_RE, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function isAuthPage() {
    if (location.hostname === "ucloud.unipus.cn") return true;
    const url = location.href.toLowerCase();
    if (/(?:sso\.unipus\.cn|\/sso\/login|cas-auth\/login|\/passport\/|\/login(?:[?#]|$))/.test(url)) {
      return true;
    }
    for (const doc of pageDocuments()) {
      if (doc.querySelector("input[type='password']")) {
        const text = (doc.body?.innerText || "").slice(0, 2000);
        if (/登录|login|sign in|统一身份认证|验证码/i.test(text)) return true;
      }
      const text = (doc.body?.innerText || "").slice(0, 400);
      if (/扫码登录|统一身份认证|请先登录|请登录后/.test(text)) return true;
    }
    return false;
  }

  function hasVideoPlayerContainer() {
    for (const doc of pageDocuments()) {
      const node = doc.querySelector(
        ".video-js, .question-video-player, .video-box, .video-learn-introduction, " +
        "[class*='video-player'], [class*='videoPlayer'], .insert-video-player"
      );
      if (node && visible(node)) return true;
    }
    return false;
  }

  function normalizeOptionText(value) {
    return String(value || "")
      .replace(/^\s*[（(]?[A-Za-z][）)]?\s*[.、,:：)）]\s*/, "")
      .replace(/\s+/g, " ")
      .replace(/^[\s"'`“”]+|[\s"'`“”。]+$/g, "")
      .trim()
      .toLocaleLowerCase();
  }

  function extractChoiceLetters(answer, optionCount) {
    const text = String(answer || "").toUpperCase();
    const letters = (text.match(/(?<![A-Z])[A-Z](?![A-Z])/g) || [])
      .filter((letter) => letter.charCodeAt(0) - 65 < optionCount);
    const compact = text.replace(/[^A-Z]/g, "");
    if (!letters.length && compact.length > 0 && compact.length <= Math.min(4, optionCount)) {
      return [...new Set(compact.split(""))]
        .filter((letter) => letter.charCodeAt(0) - 65 < optionCount);
    }
    return [...new Set(letters)];
  }

  function normalizeBlankValues(answer, count) {
    const raw = String(answer || "").trim();
    if (!raw) return [];
    let values = [];
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) values = parsed;
      else if (parsed && typeof parsed === "object") {
        const inner = parsed.answer ?? parsed.answers;
        if (Array.isArray(inner)) values = inner;
        else if (typeof inner === "string") values = inner.split(/\r?\n/);
      }
    } catch (_) {
      // Not JSON; fall through to text parsing.
    }
    if (!values.length) values = raw.split(/\r?\n/);
    values = values
      .map((value) => String(value ?? "")
        .replace(/^\s*(?:[\[(（]?\d{1,3}[\]）)]?[.)、:：-]?|[-*•])\s*/, "")
        .replace(/^[\s"'`“”]+|[\s"'`“”]+$/g, "")
        .trim())
      .filter(Boolean);
    if (count > 1 && values.length === 1) {
      const byDelimiter = raw.split(/\s*[|;；\t]\s*/).map((part) => part.trim()).filter(Boolean);
      if (byDelimiter.length === count) values = byDelimiter;
    }
    if (count > 1 && values.length === 1) {
      const tokens = raw.split(/\s+/).filter(Boolean);
      if (tokens.length === count) values = tokens;
    }
    if (count > 0 && values.length > count) values = values.slice(0, count);
    return values;
  }

  function audioSources() {
    const found = new Map();
    for (const doc of pageDocuments()) {
      for (const element of doc.querySelectorAll(
        "audio, audio source, .insert-custom-audio-player, [islistener], " +
        "[data-audio], [data-sound], [data-url], [src]"
      )) {
        const raw = element.currentSrc || element.src || element.getAttribute("src") ||
          element.getAttribute("data-audio") || element.getAttribute("data-sound") ||
          element.getAttribute("data-url");
        if (!raw) continue;
        const isAudioElement = element.tagName === "AUDIO" || element.tagName === "SOURCE";
        if (!isAudioElement && !/audio|sound|listen|voice/i.test(
          `${element.className || ""} ${element.id || ""}`
        )) continue;
        if (raw.startsWith("blob:") || raw.startsWith("data:")) {
          found.set(raw, true);
          continue;
        }
        if (!/\.(?:mp3|wav|m4a|aac|ogg|flac)(?:[?#]|$)/i.test(raw) &&
          !/\/audio\//i.test(raw)) continue;
        try {
          const absolute = new URL(raw, doc.baseURI || location.href).href.split("#")[0];
          found.set(absolute, true);
        } catch (_) {
          // Ignore malformed media URLs.
        }
      }
    }
    return [...found.keys()];
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += chunk) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return btoa(binary);
  }

  async function primePageAudio() {
    const text = (document.body?.innerText || "").slice(0, 8000);
    if (!/听录音|听单词|listen|audio|朗读所听到/i.test(text)) return;
    let clicked = 0;
    for (const doc of pageDocuments()) {
      if (!visibleDocument(doc)) continue;
      const controls = [...doc.querySelectorAll(
        ".audio-origin .audio-control-trumpet, .audio-origin .audio-control-box, " +
        ".question-audio .audio-control-trumpet, .audio-control-trumpet, " +
        ".insert-custom-audio-player, [islistener], " +
        "[class*='audio'] [class*='play']"
      )].filter((element) =>
        visible(element) && !element.closest("#freeocs-ucampus-panel, #uca-panel")
      );
      for (const element of controls.slice(0, 20)) {
        try {
          element.click();
          clicked += 1;
          await wait(220);
        } catch (_) {
          // Ignore decorative controls.
        }
      }
    }
    if (clicked) {
      updateRunLog(`已触发 ${clicked} 个听力音频加载`, "info");
      await wait(1200);
    }
  }

  async function transcribeAudioUrl(url) {
    if (AUDIO_TRANSCRIPT_CACHE.has(url)) return AUDIO_TRANSCRIPT_CACHE.get(url);
    let response;
    if (url.startsWith("blob:") || url.startsWith("data:")) {
      // U校园 的单词音频经常是页面内生成的 blob，服务端无法直接下载。
      const media = await fetch(url, { credentials: "include" });
      if (!media.ok) throw new Error(`音频读取失败：HTTP ${media.status}`);
      const buffer = await media.arrayBuffer();
      if (buffer.byteLength < 100) throw new Error("音频内容为空");
      response = await request("/api/transcribe", {
        audio_base64: arrayBufferToBase64(buffer),
        filename: "page-audio.webm",
      });
    } else {
      response = await request("/api/transcribe-url", {
        url,
        referer: location.href,
      });
    }
    const text = (response?.text || "").trim();
    AUDIO_TRANSCRIPT_CACHE.set(url, text);
    return text;
  }

  function pageAudioTranscripts(maxSources = 3, maxCount = 2) {
    const sources = audioSources();
    if (!sources.length || sources.length > maxSources) return Promise.resolve([]);
    return (async () => {
      const parts = [];
      for (const [index, url] of sources.slice(0, maxCount).entries()) {
        try {
          const text = await transcribeAudioUrl(url) || "";
          if (!text) updateRunLog(`音频${index + 1} 转写为空`, "warn");
          parts.push(text);
        } catch (error) {
          console.warn("[UCampus Assistant] 音频转写失败", url, error);
          updateRunLog(`音频${index + 1} 转写失败：${error.message}`, "error");
          parts.push("");
        }
      }
      return parts;
    })();
  }

  function pageAudioTranscript() {
    return pageAudioTranscripts().then((parts) =>
      parts.filter((text) => text).join("\n").trim()
    );
  }

  async function transcribeVideoAudio(video) {
    if (!video) return "";
    const source = video.currentSrc || video.src || "";
    if (/^https?:/i.test(source)) {
      try {
        updateRunLog("尝试直接下载视频并转写", "info");
        const response = await request("/api/transcribe-url", {
          url: source,
          referer: location.href,
        });
        if (response?.text) return response.text.trim();
      } catch (error) {
        updateRunLog(`视频地址转写失败：${error.message}`, "error");
      }
    }
    if (typeof video.captureStream !== "function" ||
      typeof MediaRecorder === "undefined") return "";
    let stream = null;
    try {
      video.muted = false;
      video.volume = 1;
      await video.play();
      await wait(1500);
      updateRunLog(
        `视频状态：${video.paused ? "暂停" : "播放中"} ${Math.round(video.currentTime)}s / ` +
        `${Number.isFinite(video.duration) ? Math.round(video.duration) : "?"}s`,
        "info"
      );
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        const context = new AudioContextClass();
        await resumeAudioContext(context);
        const source = context.createMediaElementSource(video);
        const destination = context.createMediaStreamDestination();
        source.connect(destination);
        source.connect(context.destination);
        stream = destination.stream;
      } else {
        stream = video.captureStream();
      }
    } catch (error) {
      console.warn("[UCampus Assistant] 视频音轨捕获失败", error);
      try {
        stream = video.captureStream();
      } catch (_) {
        return "";
      }
    }
    const tracks = stream.getAudioTracks ? stream.getAudioTracks() : [];
    if (!tracks.length) {
      updateRunLog("视频没有可用音轨，改用系统录音", "info");
      return "";
    }
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : "audio/webm";
    try {
      const recorder = new MediaRecorder(stream, { mimeType: mime });
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size) chunks.push(event.data);
      };
      const stopped = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.start(1000);
      const duration = Math.min(
        120,
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.ceil(video.duration) + 1
          : 60
      );
      updateRunLog(`正在录制视频音频约 ${duration} 秒`, "info");
      await wait(duration * 1000);
      recorder.stop();
      await stopped;
      const blob = new Blob(chunks, { type: mime });
      if (blob.size < 1000) return "";
      const buffer = await blob.arrayBuffer();
      const response = await request("/api/transcribe", {
        audio_base64: arrayBufferToBase64(buffer),
        filename: "video.webm",
        language: "",
      });
      return (response?.text || "").trim();
    } catch (error) {
      console.warn("[UCampus Assistant] 视频音频转写失败", error);
      return "";
    }
  }

  async function recordPageAudioTranscript(seconds = 15) {
    for (const doc of pageDocuments()) {
      for (const audio of doc.querySelectorAll("audio")) {
        try {
          await audio.play();
        } catch (_) {
          // Autoplay may be blocked; playback can be started manually.
        }
      }
      for (const play of doc.querySelectorAll(
        "[class*='audio'] [class*='play'], [class*='audio-player'], [class*='play-icon']"
      )) {
        try {
          play.click();
        } catch (_) {
          // Ignore non-clickable decorations.
        }
      }
    }
    const response = await request("/api/listen", {
      seconds,
      source: "loopback",
    });
    return (response?.text || "").trim();
  }

  function questionForDocument(doc) {
    const selectors = [
      "[data-question]",
      "[class*='question-content']",
      "[class*='questionContent']",
      "[class*='question-stem']",
      "[class*='questionStem']",
      "[class*='question-title']",
      "[class*='questionTitle']",
      "[class*='ques-title']",
    ];
    const candidates = [...doc.querySelectorAll(selectors.join(","))]
      .filter((element) => visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel"))
      .map((element) => cleanQuestionText(element.innerText?.trim() || ""))
      .filter((text) => text.length >= 12 && text.length <= 12000);
    if (candidates.length) return candidates[0];

    const root = doc.querySelector("main, article, [class*='content'], [class*='Content']") || doc.body || doc;
    const clone = root.cloneNode(true);
    clone.querySelectorAll(
      "#uca-panel, #freeocs-ucampus-panel, script, style, nav, header, footer, aside, button, [role='button'], " +
      "[class*='nav'], [class*='menu'], [class*='sidebar'], [class*='catalog'], " +
      "[class*='directory'], [class*='video'], [class*='player'], [class*='tab'], [class*='note']"
    ).forEach((element) => element.remove());
    const text = cleanQuestionText(clone.innerText?.trim() || "");
    return text.length >= 12 ? text.slice(0, 12000) : "";
  }

  function pageContextForModel() {
    for (const doc of pageDocuments()) {
      const root = doc.querySelector(
        "main, article, .question-wrap, .question-basic, [class*='question-content']"
      ) || doc.body;
      if (!root) continue;
      const clone = root.cloneNode(true);
      clone.querySelectorAll(
        "#uca-panel, #freeocs-ucampus-panel, script, style, header, footer, nav, aside, " +
        "button, input, textarea, select, .question-common-abs-choice, .option-wrap, " +
        ".question-common-abs-reply, .pc-header-tasks-container, .pc-header-tabs-container, " +
        ".pc-slider-menu-micro, .v3notes, .mark-info-btns, [class*='notes'], " +
        "[class*='comment'], [class*='discussion'], [class*='video-js']"
      ).forEach((element) => element.remove());
      const text = (clone.innerText || clone.textContent || "").trim();
      if (text.length >= 40) return cleanQuestionText(text).slice(0, 12000);
    }
    return "";
  }

  const answeredChoiceKeys = new Set();

  function choiceGroupKey(group) {
    return `${location.href}|${group.stem}|${group.options.map((option) => option.text).join("|")}`;
  }

  function optionChoiceGroups(doc) {
    return [...doc.querySelectorAll(".question-common-abs-choice")]
      .filter((group) => visible(group) && !group.closest("#uca-panel, #freeocs-ucampus-panel"))
      .map((group) => {
        const options = [...group.querySelectorAll(".option")]
          .filter((option) => visible(option))
          .map((option, index) => ({
            input: option,
            text: (option.querySelector(".content")?.innerText || option.innerText || "")
              .trim().slice(0, 500),
            caption: option.querySelector(".caption")?.innerText?.trim() ||
              String.fromCharCode(65 + index),
          }))
          .filter((option) => option.text);
        const groupText = (group.innerText || "").slice(0, 1000);
        return {
          element: group,
          stem: group.querySelector(".ques-title")?.innerText?.trim() || "",
          options,
          // Existing selections are intentionally ignored; the user wants
          // pre-filled pages re-answered.
          answered: false,
          multi: Boolean(group.querySelector(
            "[role='checkbox'], input[type='checkbox'], .checkbox, .check-box"
          )) || /multiple|choose all|select all|多选|选出所有|所有正确/i.test(groupText),
        };
      })
      .filter((group) => group.options.length >= 2);
  }

  const answeredDropdownKeys = new Set();

  function dropdownKey(item) {
    return `${location.href}|${item.stem}|${item.options.join("|")}`;
  }

  function dropdownHasAnswer(_item) {
    // Treat pre-filled values as unanswered: re-answer every page once.
    // In-run progress is tracked by answeredDropdownKeys instead.
    return false;
  }

  function optionDropdowns(doc) {
    return [...doc.querySelectorAll(".scoop-select-wrapper")]
      .filter((wrapper) => visible(wrapper) && !wrapper.closest("#uca-panel, #freeocs-ucampus-panel"))
      .map((wrapper, index) => {
        const trigger = wrapper.querySelector(".ant-dropdown-trigger");
        const textElement = wrapper.querySelector(".user-answer-text");
        const optionHost = wrapper.querySelector("div[style*='visibility: hidden']");
        const options = optionHost
          ? [...optionHost.querySelectorAll("i")]
            .map((item) => (item.textContent || item.innerText || "").trim())
            .filter(Boolean)
          : [];
        const paragraph = wrapper.closest("p");
        const stem = (paragraph?.innerText || `第 ${index + 1} 空`)
          .replace((textElement?.innerText || "").trim(), "")
          .trim();
        return { element: wrapper, trigger, textElement, options, stem, index };
      })
      .filter((item) => item.trigger && item.options.length >= 2);
  }

  function wordFromMediaUrl(src) {
    if (!src) return "";
    try {
      const hash = new URL(src, location.href).hash.replace(/^#/, "");
      const name = new URLSearchParams(hash).get("name") || "";
      const decoded = decodeURIComponent(name);
      const word = decoded
        .replace(/^\s*\d+\s*[.)、:：-]?\s*/, "")
        .replace(/\.(?:mp3|wav|m4a|aac|ogg|flac)$/i, "")
        .trim();
      return /^[A-Za-z][A-Za-z'-]*$/.test(word) ? word : "";
    } catch (_) {
      return "";
    }
  }

  function dictationItems(doc) {
    return [...doc.querySelectorAll(".word-dictation-input")]
      .filter((element) =>
        visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel")
      )
      .map((element, index) => {
        const wrap = element.closest(".reply-area-wrap") ||
          element.closest(".comp-word-dictation-reply") || element.parentElement;
        const audio = wrap?.querySelector("audio");
        const src = audio?.currentSrc || audio?.src || audio?.getAttribute("src") || "";
        return {
          element,
          slots: [...element.querySelectorAll(".input-item")].filter(visible),
          src,
          word: wordFromMediaUrl(src),
          index,
        };
      })
      .filter((item) => item.slots.length);
  }

  async function answerDictation(controls) {
    const items = controls.items || [];
    if (!items.length) return false;
    updateRunLog(`检测到 ${items.length} 个听写单词，开始转写音频`, "info");
    setStatus("正在转写听写音频…");
    const answers = [];
    for (const [index, item] of items.entries()) {
      let transcriptWord = "";
      if (item.src) {
        try {
          const transcript = (await transcribeAudioUrl(item.src) || "").trim();
          const match = transcript.match(/[A-Za-z][A-Za-z'-]*/);
          if (match) transcriptWord = match[0];
          if (transcriptWord) updateRunLog(`听写 ${index + 1} 音频转写：${transcriptWord}`, "info");
        } catch (error) {
          updateRunLog(`听写 ${index + 1} 音频转写失败：${error.message}`, "warn");
        }
      }
      const candidates = [];
      // The audio URL name is usually the exact word; ASR can hear "hat" as
      // "that".  Prefer the candidate whose letter count matches the slots.
      if (item.word) candidates.push(item.word);
      if (transcriptWord) candidates.push(transcriptWord);
      let word = candidates.find((candidate) =>
        candidate.replace(/[^A-Za-z]/g, "").length === item.slots.length
      ) || candidates[0] || "";
      if (!word) {
        await waitingForManual(`听写 ${index + 1} 无法转写，请手动完成`);
        return false;
      }
      const letters = word.replace(/[^A-Za-z]/g, "");
      if (!letters) continue;
      if (item.slots.length < letters.length) {
        await waitingForManual(`听写 ${index + 1} 字母格不足（${item.slots.length}/${letters.length}），请手动完成`);
        return false;
      }
      item.slots[0].click();
      for (const [offset, letter] of [...letters].entries()) {
        const slot = item.slots[offset];
        slot.click();
        const code = `Key${letter.toUpperCase()}`;
        const init = {
          key: letter,
          code,
          keyCode: letter.toUpperCase().charCodeAt(0),
          which: letter.toUpperCase().charCodeAt(0),
          bubbles: true,
          cancelable: true,
        };
        for (const target of [document.activeElement, slot, item.element, document, window]) {
          if (target && typeof target.dispatchEvent === "function") {
            target.dispatchEvent(new KeyboardEvent("keydown", init));
            target.dispatchEvent(new KeyboardEvent("keypress", init));
            target.dispatchEvent(new KeyboardEvent("keyup", init));
          }
        }
        await wait(80);
      }
      // Some dictation widgets do not expose a keyboard target. Fill the
      // visible letter spans as a fallback and notify React via input events.
      const entered = [...item.element.querySelectorAll(".letter")]
        .map((element) => (element.textContent || "").trim())
        .join("");
      if (entered.length < letters.length) {
        item.element.querySelectorAll(".letter").forEach((element, offset) => {
          if (offset < letters.length) element.textContent = letters[offset];
        });
        item.element.dispatchEvent(new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: letters,
        }));
      }
      answers.push(word);
      updateRunLog(`听写 ${index + 1} 已填入：${word}`, "info");
    }
    if (!answers.length) return false;
    setPanelAnswer(answers.join("\n"), "听写答案");
    updateRunLog(`听写已完成：${answers.join(" / ")}`, "success");
    await waitingForManual("听写答案已填入，等待手动提交");
    return false;
  }

  const answeredRadioKeys = new Set();

  function radioGroupKey(group) {
    return [location.href, group.name, group.stem,
      group.options.map((option) => option.text).join("|")].join("|");
  }

  function checkboxGroups(doc) {
    const boxes = [...doc.querySelectorAll("input[type='checkbox'], [role='checkbox']")]
      .filter((element) => controlVisible(element) &&
        !element.closest("#uca-panel, #freeocs-ucampus-panel") &&
        !element.closest("header, nav, [class*='notes'], [class*='search']") &&
        element.closest(".question-common-abs-choice, .question-basic, [class*='question'], .item"));
    const byName = new Map();
    for (const box of boxes) {
      const container = box.closest(
        ".question-common-abs-choice, .question-basic, [class*='question-item'], " +
        "[class*='questionItem'], [class*='question'], .item"
      );
      const name = box.name || box.getAttribute("name");
      const key = name || container || box;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(box);
    }
    const groups = [];
    for (const [groupKey, inputs] of byName) {
      if (inputs.length < 2) continue;
      const options = inputs.map((input, index) => {
        const label = input.labels?.[0] || input.closest("label");
        const text = label?.innerText?.trim() || input.getAttribute("aria-label") ||
          input.parentElement?.innerText?.trim() || input.value || `选项 ${index + 1}`;
        return { input, text: text.slice(0, 500) };
      });
      if (options.some((option) => !option.text)) continue;
      const container = inputs[0].closest(
        ".question-common-abs-choice, .question-basic, [class*='question-item'], " +
        "[class*='questionItem'], [class*='question']"
      );
      groups.push({
        name: typeof groupKey === "string" ? groupKey : "checkbox-group",
        inputs,
        options,
        stem: (container?.innerText || questionForDocument(doc) || "")
          .trim().slice(0, 2000),
        element: container || doc.body,
        answered: false,
      });
    }
    return groups;
  }

  function radioGroups(doc) {
    const radios = [...doc.querySelectorAll("input[type='radio'], [role='radio']")]
      .filter((element) => controlVisible(element) &&
        !element.closest("#uca-panel, #freeocs-ucampus-panel") &&
        !element.closest("header, nav, [class*='notes'], [class*='search']"));
    const byName = new Map();
    for (const radio of radios) {
      const name = radio.name || radio.getAttribute("name");
      const container = radio.closest(
        ".question-common-abs-choice, .question-basic, [class*='question-item'], " +
        "[class*='questionItem'], [class*='question']"
      );
      const key = name || container || radio;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(radio);
    }
    const groups = [];
    for (const [groupKey, inputs] of byName) {
      if (inputs.length < 2) continue;
      const options = inputs.map((input, index) => {
        const label = input.labels?.[0] || input.closest("label");
        const text = label?.innerText?.trim() || input.getAttribute("aria-label") ||
          input.parentElement?.innerText?.trim() || input.value || `选项 ${index + 1}`;
        return { input, text: text.slice(0, 500) };
      });
      if (options.some((option) => !option.text)) continue;
      const container = inputs[0].closest(
        ".question-common-abs-choice, .question-basic, [class*='question-item'], " +
        "[class*='questionItem'], [class*='question']"
      );
      const stem = (container?.innerText || questionForDocument(doc) || "")
        .trim().slice(0, 2000);
      groups.push({
        name: typeof groupKey === "string" ? groupKey : "radio-group",
        inputs,
        options,
        stem,
        element: container || doc.body,
        answered: false,
      });
    }
    return groups;
  }

  function currentQuestion() {
    const selected = window.getSelection()?.toString().trim();
    if (selected) return selected.slice(0, 12000);
    if (isCourseDetailPage()) return "";
    for (const doc of pageDocuments()) {
      const dropdowns = optionDropdowns(doc);
      if (!dropdowns.length) continue;
      const pending = dropdowns.find((item) =>
        !dropdownHasAnswer(item) && !answeredDropdownKeys.has(dropdownKey(item))
      );
      return pending ? pending.stem : "";
    }
    for (const doc of pageDocuments()) {
      const groups = checkboxGroups(doc);
      if (!groups.length) continue;
      const pending = groups.find((group) =>
        !group.answered && !answeredChoiceKeys.has(choiceGroupKey(group))
      );
      return pending ? pending.stem : "";
    }
    for (const doc of pageDocuments()) {
      const groups = radioGroups(doc);
      if (!groups.length) continue;
      const pending = groups.find((group) =>
        !group.answered && !answeredRadioKeys.has(radioGroupKey(group))
      );
      return pending ? pending.stem : "";
    }
    for (const doc of pageDocuments()) {
      const groups = optionChoiceGroups(doc);
      if (!groups.length) continue;
      const pending = groups.find((group) => !group.answered && !answeredChoiceKeys.has(choiceGroupKey(group)));
      return pending ? pending.stem : "";
    }
    for (const doc of pageDocuments()) {
      const text = questionForDocument(doc);
      if (text) return text;
    }
    return "";
  }
  function answerControls() {
    const docs = pageDocuments();
    for (const doc of docs) {
      const dictations = dictationItems(doc);
      if (dictations.length) {
        return { type: "dictation", items: dictations, doc };
      }
      const fileInputs = [...doc.querySelectorAll("input[type='file']")]
        .filter((element) => !element.closest("#uca-panel, #freeocs-ucampus-panel"));
      if (fileInputs.length) {
        const pageText = (doc.body?.innerText || "").slice(0, 1500);
        const uploadContainer = doc.querySelector(
          ".question-multi-file-upload, .unipus-upload, .ant-upload, " +
          "[class*='audio-upload'], [class*='record-upload'], [class*='upload-audio']"
        );
        const speaks = /Speaking task|上传音频|上传录音|录音上传|将音频|录一段|朗读|音频|voice recording|record your (?:voice|answer|conversation)|upload your recording|record a (?:voice|answer)/i
          .test(pageText);
        const audioInput = fileInputs.find((element) =>
          /audio|wav|mp3|mpeg|ogg|webm/i.test(element.getAttribute("accept") || "")
        );
        if (audioInput && (speaks || uploadContainer)) {
          return { type: "oral", audioInput, doc };
        }
        if (speaks && fileInputs.length === 1) {
          return { type: "oral", audioInput: fileInputs[0], doc };
        }
        if (uploadContainer && fileInputs.length === 1) {
          const hint = `${uploadContainer.innerText || ""} ${uploadContainer.className || ""}`;
          if (/录音|音频|audio|voice|record/i.test(hint)) {
            return { type: "oral", audioInput: fileInputs[0], doc };
          }
        }
      }
      const pageText = (doc.body?.innerText || "").slice(0, 1200);
      if (/Start role-play/i.test(pageText)) {
        return { type: "roleplay", doc };
      }
      const checkboxGroupsInDoc = checkboxGroups(doc);
      if (checkboxGroupsInDoc.length) {
        const pending = checkboxGroupsInDoc.find((group) =>
          !group.answered && !answeredChoiceKeys.has(choiceGroupKey(group))
        );
        if (!pending) {
          return { type: "unsupported", reason: "本页选择题已全部作答。" };
        }
        return {
          type: "multi-choice",
          options: pending.options,
          group: pending,
          groups: checkboxGroupsInDoc,
          doc,
        };
      }
      const radioGroupsInDoc = radioGroups(doc);
      if (radioGroupsInDoc.length) {
        const pending = radioGroupsInDoc.find((group) =>
          !group.answered && !answeredRadioKeys.has(radioGroupKey(group))
        );
        if (!pending) {
          return { type: "unsupported", reason: "本页选择题已全部作答。" };
        }
        return {
          type: "choice",
          options: pending.options,
          group: pending,
          groups: radioGroupsInDoc,
          radioGroup: true,
          doc,
        };
      }

      const dropdowns = optionDropdowns(doc);
      if (dropdowns.length) {
        const pending = dropdowns.find((item) =>
          !dropdownHasAnswer(item) && !answeredDropdownKeys.has(dropdownKey(item))
        );
        if (!pending) {
          return { type: "unsupported", reason: "本页下拉题已全部作答。" };
        }
        return {
          type: "dropdown",
          options: pending.options.map((text) => ({ text })),
          dropdown: pending,
          dropdowns,
          doc,
        };
      }

      const choiceGroups = optionChoiceGroups(doc);
      if (choiceGroups.length) {
        const group = choiceGroups.find((item) =>
          !item.answered && !answeredChoiceKeys.has(choiceGroupKey(item))
        );
        if (!group) {
          return { type: "unsupported", reason: "本页选择题已全部作答。" };
        }
        return {
          type: group.multi ? "multi-choice" : "choice",
          options: group.options,
          group,
          groups: choiceGroups,
          doc,
        };
      }

      const recordButtons = [...doc.querySelectorAll(".button-record, .record-icon")]
        .filter((button) =>
          button.getClientRects().length > 0 && !button.closest("#uca-panel, #freeocs-ucampus-panel")
        )
        .filter((button, index, list) =>
          !list.some((other, otherIndex) =>
            otherIndex !== index && other.contains(button)
          )
        );
      if (recordButtons.length) {
        const items = recordButtons.map((button, index) => {
          let item = button.closest(".oral-study-sentence, .sentence-container, .item");
          if (!item) {
            let parent = button.parentElement;
            for (let depth = 0; depth < 4 && parent; depth += 1) {
              const value = (parent.innerText || "").trim();
              if (value.length > 5 && value.length < 400) {
                item = parent;
                break;
              }
              parent = parent.parentElement;
            }
          }
          const explicit = item?.querySelector(
            ".sentence-html-container .component-htmlview p, .component-htmlview p, " +
            "[class*='sentence'] p, [class*='content'] p"
          )?.innerText;
          let text = (explicit || item?.innerText || "").trim();
          text = text.split(/\n+/)
            .map((line) => line.trim())
            .filter((line) => line &&
              !/^(播放|录音|重录|评分|朗读|麦克风|录音中|停止)$/.test(line))
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (text.length > 300) text = text.slice(0, 300);
          return { button, item, text, index };
        });
        if (items.every((item) => !item.text || /^第 \d+ 句$/.test(item.text))) {
          return { type: "unsupported", reason: "无法提取朗读句子文本。", doc };
        }
        return { type: "dubbing", items, doc };
      }

      const sortable = doc.querySelector(".sortable-list-wrapper");
      if (sortable) {
        const words = [...sortable.querySelectorAll(".sortable-list-question-no")]
          .map((element) => (element.innerText || "").trim())
          .filter(Boolean);
        const meanings = [...sortable.querySelectorAll(".sequence-reply-view-item-text")]
          .map((element) => {
            const text = (element.innerText || "").trim();
            const match = /^([A-Z])[.、]/.exec(text);
            return {
              element,
              label: match ? match[1] : "",
              text,
            };
          })
          .filter((item) => item.label);
        if (words.length >= 2 && meanings.length === words.length) {
          return { type: "matching", words, meanings, wrapper: sortable, doc };
        }
      }      const scoopInputs = [...doc.querySelectorAll(".comp-abs-input")]
        .filter((element) =>
          !element.closest("#uca-panel, #freeocs-ucampus-panel") &&
          !element.closest("#mark-edit-in, [class*='notes'], [class*='search']") &&
          element.closest(".question-common-abs-scoop, .question-basic, [class*='question']") &&
          element.querySelector("input"))
        .map((element) => element.querySelector("input"))
        .filter((element) => element && !element.closest("#uca-panel, #freeocs-ucampus-panel"));
      if (scoopInputs.length === 1) return { type: "blank", fields: scoopInputs, doc };
      if (scoopInputs.length > 1) return { type: "blanks", fields: scoopInputs, doc };

      const fields = [...doc.querySelectorAll(
        ".question-inputbox-input, .fe-scoop input, .comp-abs-input input, " +
        "textarea[placeholder], input[placeholder], " +
        "[contenteditable='true'][data-placeholder]"
      )].filter((element) => {
        if (element.closest("#uca-panel, #freeocs-ucampus-panel")) return false;
        if (!visible(element)) {
          // fill-blank components often keep the real <input> visually hidden
          // and expose a clickable .comp-abs-input wrapper instead.
          const wrapper = element.closest(".comp-abs-input");
          if (!wrapper || !visible(wrapper)) return false;
        }
        const hint = [
          element.className,
          element.getAttribute("placeholder"),
          element.getAttribute("data-placeholder"),
          element.getAttribute("aria-label"),
        ].join(" ").toLowerCase();
        return element.matches(
          ".question-inputbox-input, .fe-scoop input, .comp-abs-input input"
        ) || /answer|response|blank|答案|作答|回答/.test(hint);
      });
      if (fields.length === 1) return { type: "blank", fields, doc };
      if (fields.length > 1) {
        const essays = fields.every((field) => field.tagName === "TEXTAREA");
        if (essays) return { type: "essays", fields, doc };
        return { type: "blanks", fields, doc };
      }

      const audioInput = [...doc.querySelectorAll("input[type='file']")]
        .find((element) => visible(element) && /audio|wav|mp3|mpeg/i.test(element.accept || ""));
      if (audioInput) return { type: "oral", audioInput, doc };
    }
    return { type: "unsupported", reason: "未检测到支持的选择题、单个填空框或音频上传控件。" };
  }

  function videoForAutomation() {
    const videos = pageDocuments().flatMap((doc) =>
      [...doc.querySelectorAll("video")].filter((video) =>
        visible(video) && (
          video.currentSrc || video.src || video.getAttribute("data-src") ||
          video.querySelector("source[src]")
        )
      )
    );
    if (videos.length > 1) {
      return { error: "当前页面检测到多个可见视频，无法确定应播放哪一个。" };
    }
    return { video: videos[0] || null };
  }

  async function waitForVisibleVideo(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const result = videoForAutomation();
      if (result.video) return result.video;
      if (!hasVideoPlayerContainer()) return null;
      await wait(500);
    }
    return null;
  }

  function setStatus(text, error = false) {
    currentStatus = error ? `失败：${text}` : text;
    const host = document.getElementById("freeocs-ucampus-panel");
    const statusEl = host?.querySelector('[data-foc="status"]');
    if (statusEl) statusEl.textContent = currentStatus;
  }

  async function reportUnknown(question, reason) {
    const payload = {
      question: question || "(未能提取题目文本)",
      reason,
      page_title: document.title,
      page_url: location.href,
    };
    try {
      await request("/api/automation/unrecognized", payload);
    } catch (error) {
      console.error("[UCampus Assistant] 无法记录未识别题目", payload, error);
      setStatus(`未识别：${reason}；写入日志失败：${error.message}`, true);
      return false;
    }
    const label = question ? "未识别题目" : "无题目页面";
    updateRunLog(`无法继续：${reason}`, "error");
    showAiButton(true, payload.question, reason);
    setStatus(`${label}，已记录：${reason}\n${payload.question.slice(0, 240)}`, true);
    console.warn("[UCampus Assistant] 未识别题目", payload);
    runHalted = true;
    return true;
  }

  function writeText(element, value) {
    if (element.isContentEditable) element.textContent = value;
    else {
      const prototype = element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, value);
      else element.value = value;
    }
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function dragSortable(source, target) {
    const sourceRect = source.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const startX = sourceRect.left + sourceRect.width / 2;
    const startY = sourceRect.top + sourceRect.height / 2;
    const endX = targetRect.left + targetRect.width / 2;
    // Drop slightly above the target centre so the item is inserted *before*
    // the target.  U校园's sortable uses mouse events, not HTML5 DnD.
    const endY = targetRect.top + Math.min(8, targetRect.height / 4);
    const fire = (element, type, x, y, buttons = 1) => element.dispatchEvent(
      new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons,
        clientX: x,
        clientY: y,
      })
    );
    fire(source, "mousedown", startX, startY);
    await wait(120);
    for (let step = 1; step <= 12; step += 1) {
      const x = startX + ((endX - startX) * step) / 12;
      const y = startY + ((endY - startY) * step) / 12;
      fire(document, "mousemove", x, y);
      await wait(60);
    }
    fire(target, "mouseup", endX, endY, 0);
    fire(document, "mouseup", endX, endY, 0);
    await wait(500);
  }

  async function applyAnswer(answer, controls) {
    if (controls.type === "matching") {
      let letters = [];
      try {
        const parsed = JSON.parse(answer.trim());
        if (Array.isArray(parsed)) letters = parsed.map((item) => String(item).trim().toUpperCase());
      } catch (_) {
        letters = (answer.match(/[A-Z]/g) || []);
      }
      const desired = letters
        .map((letter) => controls.meanings.find((item) => item.label === letter))
        .filter(Boolean);
      if (desired.length !== controls.meanings.length) {
        throw new Error(`模型返回 ${desired.length} 个答案，页面有 ${controls.meanings.length} 项。`);
      }
      const sequence = desired.map((item) => item.label).join(" → ");
      const pairs = desired.map((item, index) => {
        const word = (controls.words?.[index] || String(index + 1)).replace(/\.$/, "").trim();
        return `${word} → ${item.label}`;
      }).join("；");
      updateRunLog(`排序/匹配正确答案：${sequence}`, "info");
      updateRunLog(`对应关系：${pairs}`, "info");
      setPanelAnswer(`${sequence}\n${pairs}`, "排序/匹配正确答案");
      setStatus("请按面板答案手动拖拽，然后提交");
      await waitingForManual("排序/匹配答案已显示在面板；请手动拖拽后提交");
      return;
    }
    if (controls.type === "dictation") {
      return (controls.items || []).every((item) =>
        [...item.element.querySelectorAll(".letter")]
          .every((element) => (element.textContent || "").trim())
      );
    }
    if (controls.type === "dropdown") {
      const pending = controls.dropdown;
      const normalized = answer.trim();
      const letterMatch = /^([A-Za-z])[.)、\s]?$/.exec(normalized);
      const optionIndex = letterMatch
        ? letterMatch[1].toUpperCase().charCodeAt(0) - 65
        : -1;
      const optionText = optionIndex >= 0
        ? pending.options[optionIndex]
        : pending.options.find((text) =>
          normalized.toLowerCase().includes(text.toLowerCase()) ||
          text.toLowerCase().includes(normalized.toLowerCase())
        );
      if (!optionText) throw new Error("模型答案无法与下拉选项匹配。");
      pending.trigger.click();
      await wait(400);
      const menuItems = pageDocuments().flatMap((doc) => [
        ...doc.querySelectorAll(
          ".ant-dropdown li, .ant-dropdown-menu-item, [role='option'], .ant-select-item-option"
        ),
      ]).filter(visible);
      const target = menuItems.find((item) =>
        (item.innerText || "").trim() === optionText
      ) || menuItems.find((item) =>
        (item.innerText || "").includes(optionText)
      );
      if (target) {
        target.click();
      } else {
        const hiddenOption = [...pending.element.querySelectorAll("i")]
          .find((item) => (item.innerText || "").trim() === optionText);
        if (!hiddenOption) throw new Error("下拉选项未能展开或未找到匹配项。");
        hiddenOption.click();
      }
      await wait(450);
      // The component may replace its DOM when selecting; re-query instead of
      // holding a stale .user-answer-text reference.
      const currentText = (pending.element.querySelector(
        ".user-answer-text, .user-answer"
      )?.innerText || "").trim();
      if (!currentText || /点击选择|请选择/.test(currentText)) {
        const hiddenOption = [...pending.element.querySelectorAll("i")]
          .find((item) => (item.innerText || "").trim() === optionText);
        if (hiddenOption) {
          hiddenOption.click();
          await wait(350);
        }
        const retryText = (pending.element.querySelector(
          ".user-answer-text, .user-answer"
        )?.innerText || "").trim();
        if (!retryText || /点击选择|请选择/.test(retryText)) {
          throw new Error("下拉选项未能选中。");
        }
      }
      answeredDropdownKeys.add(dropdownKey(pending));
      return;
    }
    if (controls.type === "multi-choice") {
      const letters = extractChoiceLetters(answer, controls.options.length);
      const normalized = normalizeOptionText(answer);
      const matched = controls.options.filter((option, index) => {
        const letter = String.fromCharCode(65 + index);
        const optionText = normalizeOptionText(option.text);
        return letters.includes(letter) || (optionText && normalized.includes(optionText));
      });
      if (!matched.length) throw new Error("模型答案无法与多选题选项匹配。");
      for (const option of matched) {
        option.input.click();
        option.input.dispatchEvent(new Event("input", { bubbles: true }));
        option.input.dispatchEvent(new Event("change", { bubbles: true }));
        await wait(250);
      }
      if (controls.group) answeredChoiceKeys.add(choiceGroupKey(controls.group));
      return;
    }
    if (controls.type === "choice") {
      const letters = extractChoiceLetters(answer, controls.options.length);
      const normalized = normalizeOptionText(answer);
      let matched = controls.options.find((option, index) =>
        letters.includes(String.fromCharCode(65 + index))
      );
      if (!matched) {
        matched = controls.options.find((option) => {
          const optionText = normalizeOptionText(option.text);
          return optionText && normalized.includes(optionText);
        });
      }
      if (!matched) {
        matched = controls.options.find((option) => {
          const optionText = normalizeOptionText(option.text);
          return optionText.length >= 3 && normalized.length >= 3 &&
            (optionText.includes(normalized) || normalized.includes(optionText));
        });
      }
      if (!matched) throw new Error("模型答案无法与页面选项匹配。");
      if (matched.input.matches("[role='radio']") || matched.input.matches(".option")) {
        matched.input.click();
      } else {
        matched.input.checked = true;
      }
      matched.input.dispatchEvent(new Event("input", { bubbles: true }));
      matched.input.dispatchEvent(new Event("change", { bubbles: true }));
      if (controls.group) answeredChoiceKeys.add(choiceGroupKey(controls.group));
      if (controls.radioGroup) answeredRadioKeys.add(radioGroupKey(controls.group));
      return;
    }
    if (controls.type === "blank") {
      if (!answer.trim()) throw new Error("模型未返回可填入的答案。");
      writeText(controls.fields[0], answer.trim());
      return;
    }
    if (controls.type === "blanks") {
      const values = normalizeBlankValues(answer, controls.fields.length);
      if (values.length !== controls.fields.length) {
        throw new Error(`模型返回 ${values.length} 个答案，页面有 ${controls.fields.length} 个空。`);
      }
      controls.fields.forEach((field, index) => {
        writeText(field, String(values[index]).trim());
      });
      return;
    }
    throw new Error("此题型不能直接回填答案。");
  }

  async function attachReferenceAudio(audioInput) {
    throw new Error("参考录音模式未启用，请使用语音合成");
  }

  async function attachGeneratedAudio(audioInput, text) {
    const blob = await request("/api/speech", {
      text,
      output_format: "mp3",
    }, "blob");
    const extension = blob.type.includes("wav") ? "wav" : "mp3";
    const mime = blob.type || (extension === "wav" ? "audio/wav" : "audio/mpeg");
    const file = new File([blob], `assistant-answer.${extension}`, { type: mime });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    try {
      audioInput.files = transfer.files;
    } catch (error) {
      throw new Error(`无法写入上传控件：${error.message}`);
    }
    audioInput.dispatchEvent(new Event("input", { bubbles: true }));
    audioInput.dispatchEvent(new Event("change", { bubbles: true }));
    audioBlob = blob;
    await wait(1200);
    const count = audioInput.files?.length || 0;
    updateRunLog(
      `已生成音频 ${Math.round(blob.size / 1024)} KB，写入上传框文件数：${count}`,
      "info"
    );
    if (count === 0) {
      throw new Error("上传框没有接收到音频文件。");
    }
  }

  async function playVideoToEnd(video) {
    if (video.ended || (Number.isFinite(video.duration) &&
      video.duration > 0 && video.currentTime >= video.duration - 0.5)) {
      return true;
    }
    updateRunLog("检测到无题视频，等待视频播放完成", "info");
    setStatus("正在播放课程视频；播放完成后继续下一步…");
    const wasMuted = video.muted;
    try {
      const playback = video.play();
      if (playback && typeof playback.then === "function") await playback;
    } catch (error) {
      // Autoplay with audio is commonly blocked.  Retry muted; restore the
      // user's mute state after playback has started.
      try {
        video.muted = true;
        const playback = video.play();
        if (playback && typeof playback.then === "function") await playback;
        window.setTimeout(() => { video.muted = wasMuted; }, 1000);
        updateRunLog("视频已静音播放；播放完成后继续", "info");
      } catch (mutedError) {
        throw new Error(`视频无法自动播放（可能被浏览器拦截）：${mutedError.message}`);
      }
    }

    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        if (!automationRunning) {
          clearInterval(timer);
          resolve(false);
          return;
        }
        if (video.error) {
          clearInterval(timer);
          reject(new Error("视频播放失败或媒体加载出错。"));
          return;
        }
        if (video.ended || (Number.isFinite(video.duration) &&
          video.duration > 0 && video.currentTime >= video.duration - 0.5)) {
          clearInterval(timer);
          resolve(true);
        }
      }, 500);
    });
  }

  function unsupportedVideoSignal() {
    const matcher = /(?:视频|video|播放器)[^\n]{0,40}(?:不支持|无法播放|播放失败|加载失败|格式不支持)|(?:不支持|无法播放|播放失败)[^\n]{0,40}(?:视频|video|播放器)/i;
    for (const doc of pageDocuments()) {
      const text = (doc.body?.innerText || "").slice(0, 5000);
      if (text && matcher.test(text)) return true;
    }
    return false;
  }

  async function handleUnsupportedVideo(reason) {
    setStatus("视频无法播放，按内容页继续…");
    updateRunLog(`视频不可用（${reason}），继续下一项`, "warn");
    await wait(1200);
    dismissBlockingDialog();
    await wait(500);
  }

  function nextQuestionButton() {
    const matcher = /^(下一题|下一步|下一页|下一节|下一课|下一章|继续学习|继续|完成并继续|next(?:\s+(?:question|step|lesson|chapter))?|continue)\s*[>›→]?$/i;
    for (const doc of pageDocuments()) {
      const buttons = [...doc.querySelectorAll(
        "button, a, [role='button'], [class*='next'], [class*='Next']"
      )]
        .filter((element) => visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel"));
      const button = buttons.find((element) => {
        const text = (element.innerText || element.getAttribute("aria-label") ||
          element.getAttribute("title") || "").trim();
        const isNextByClass = /(?:^|[\s_-])next(?:[\s_-]|$)/i.test(element.className || "");
        return (matcher.test(text) || (!text && isNextByClass)) && !element.disabled &&
          element.getAttribute("aria-disabled") !== "true";
      });
      if (button) return button;
    }
    return null;
  }

  function practiceTabs(doc) {
    return [...doc.querySelectorAll(
        "[role='tab'], button, [role='button'], [class*='tab'], [class*='Tab'], [class*='radio-button-wrapper'], [class*='sub-tab'], [class*='subTab'], .pc-task"
      )].filter((element) =>
        visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel") &&
        !element.matches("[class*='taskItemContainer']") &&
        !element.closest(".ant-collapse-header, [class*='collapse-header']")
      );
  }

  function practiceTab() {
    for (const doc of pageDocuments()) {
      const tabs = practiceTabs(doc);
      const practice = tabs.find((element) =>
        (element.innerText || element.getAttribute("aria-label") || "")
          .trim().toLowerCase() === "practice"
      );
      if (!practice) continue;
      let active = false;
      let ancestor = practice;
      for (let depth = 0; ancestor && depth < 4; depth += 1, ancestor = ancestor.parentElement) {
        const className = typeof ancestor.className === "string" ? ancestor.className : "";
        active ||= ancestor.getAttribute("aria-selected") === "true" ||
          ancestor.getAttribute("aria-current") === "page" ||
          /\b(?:active|selected|current)\b|tabActive|tabItemActive|pc-header-tab-activity|pc-header-task-activity|pc-menu-activity|ant-tabs-tab-active|ant-radio-button-wrapper-checked/i.test(className);
        const siblings = [...(ancestor.parentElement?.children || [])];
        const miniLecture = siblings.find((sibling) =>
          sibling !== ancestor &&
          (sibling.innerText || "").trim().toLowerCase() === "mini-lecture"
        );
        if (miniLecture) {
          const miniClass = typeof miniLecture.className === "string" ? miniLecture.className : "";
          const miniActive = miniLecture.getAttribute("aria-selected") === "true" ||
            miniLecture.getAttribute("aria-current") === "page" ||
            /\b(?:active|selected|current)\b|tabActive|tabItemActive|pc-header-tab-activity|pc-header-task-activity|pc-menu-activity|ant-tabs-tab-active|ant-radio-button-wrapper-checked/i.test(miniClass);
          if (miniActive) active = false;
        }
        if (active) break;
      }
      if (
        [practice, practice.closest("[role='tab'], .ant-tabs-tab")]
          .filter(Boolean)
          .some((element) =>
          element.getAttribute("aria-selected") === "true" ||
          element.getAttribute("aria-current") === "page" ||
          /\b(?:active|selected|current)\b|tabActive|tabItemActive|pc-header-tab-activity|pc-header-task-activity|pc-menu-activity|ant-tabs-tab-active|ant-radio-button-wrapper-checked/i.test(
            typeof element.className === "string" ? element.className : ""
          ))
      ) active = true;
      return active ? null : practice;
    }
    return null;
  }

  function tabElementActive(element) {
    let node = element;
    for (let depth = 0; node && depth < 5; depth += 1, node = node.parentElement) {
      const className = typeof node.className === "string" ? node.className : "";
      if (node.getAttribute("aria-selected") === "true" ||
        node.getAttribute("aria-current") === "page" ||
        node.getAttribute("aria-current") === "true" ||
        /(?:^|[\s_-])(?:active|selected|current)(?:$|[\s_-])|tabActive|tabItemActive|pc-header-tab-activity|pc-header-task-activity|pc-menu-activity|ant-tabs-tab-active|ant-radio-button-wrapper-checked/i
          .test(className)) {
        return true;
      }
    }
    return false;
  }

  function contentTabs() {
    if (isCourseDetailPage()) return [];
    for (const doc of pageDocuments()) {
      const width = window.innerWidth || 1200;
      const seen = new Set();
      const tabs = [];
      for (const element of practiceTabs(doc)) {
        const text = (element.innerText || element.getAttribute("aria-label") ||
          element.getAttribute("title") || "").trim().replace(/\s+/g, " ");
        if (!text || text.length > 60) continue;
        if (/^Module\s+\d+$/i.test(text)) continue;
        if (/^(教程学习|作业|考核方案|综合成绩|学习报告|补充资源)$/.test(text)) continue;
        const rect = element.getBoundingClientRect();
        if (rect.top < 0 || rect.top > 280) continue;
        if (rect.left > width * 0.75 || rect.left < 0) continue;
        const className = typeof element.className === "string" ? element.className : "";
        if (element.getAttribute("role") !== "tab" &&
          !/(?:tab|radio-button-wrapper|sub-tab|subTab|pc-task)/i.test(className)) continue;
        if (element.querySelector(
          "[role='tab'], [class*='tabItemContainer'], [class*='tabItem'], " +
          "[class*='pc-tab-view-container'], [class*='pc-header-tab'], " +
          "[class*='ant-tabs-nav']"
        )) continue;
        const key = text;
        if (seen.has(key)) continue;
        seen.add(key);
        // The click handler is on the inner .pc-tab-view-container; clicking
        // only its outer .pc-header-tab wrapper does not switch the tab.
        tabs.push({
          element,
          label: text,
          top: rect.top,
          left: rect.left,
          active: tabElementActive(element),
        });
      }
      if (tabs.length >= 2) {
        const filtered = tabs.filter((tab) => !tabs.some((other) =>
          other !== tab && other.label &&
          tab.label.includes(other.label) && tab.element.contains(other.element)
        ));
        return filtered.sort((left, right) => left.top - right.top || left.left - right.left);
      }
    }
    return [];
  }

  function nextReadingTab() {
    const labels = ["Pre-reading", "Reading in detail", "Reading comprehension"];
    const onReadingSection = pageDocuments().some((doc) =>
      [...doc.querySelectorAll("[class*='pc-header-tab']")].some((element) =>
        (element.innerText || "").trim() === "Cultural reading" &&
        tabElementActive(element)
      )
    );
    if (!onReadingSection) return null;
    for (const doc of pageDocuments()) {
      const found = [];
      for (const element of doc.querySelectorAll("div, span, button, a, li")) {
        const text = (element.innerText || "").trim();
        if (!labels.includes(text)) continue;
        if (element.querySelector("div, span, button, a, li")) continue;
        if (!element.getClientRects().length) continue;
        if (found.some((item) => item.label === text)) continue;
        found.push({ element, label: text, active: tabElementActive(element) });
      }
      if (found.length < 2) continue;
      updateRunLog(
        `阅读二级 Tab：${found.map((item) => `${item.label}${item.active ? "*" : ""}`).join(" | ")}`,
        "info"
      );
      const index = found.findIndex((item) => item.active);
      if (index >= 0 && index + 1 < found.length) {
        return {
          element: found[index + 1].element,
          label: found[index + 1].label,
          sectionTab: true,
        };
      }
    }
    return null;
  }

  function nextPracticeTask() {
    // U校园 Practice 1..4 are .pc-task nodes inside the Practice header, not
    // standard tabs.  Advancing the catalog micro before Practice 4 would
    // silently skip the remaining practice pages.
    if (practiceTab()) return null;
    for (const doc of pageDocuments()) {
      const tasks = [...doc.querySelectorAll(".pc-task")]
        .filter((element) =>
          visible(element) &&
          !element.closest("#uca-panel, #freeocs-ucampus-panel")
        )
        .map((element) => ({
          element,
          label: (element.innerText || element.getAttribute("title") || "")
            .trim().replace(/\s+/g, " "),
          active: tabElementActive(element),
        }))
        .filter((task) => /^Practice\s*\d+$/i.test(task.label));
      if (tasks.length < 2) continue;
      const index = tasks.findIndex((task) => task.active);
      if (index >= 0 && index + 1 < tasks.length) {
        return {
          element: tasks[index + 1].element,
          label: tasks[index + 1].label,
          sectionTab: true,
        };
      }
    }
    return null;
  }

  function nextNestedTab() {
    for (const doc of pageDocuments()) {
      const tabs = [...doc.querySelectorAll(".ant-tabs-tab")]
        .filter((element) => visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel"))
        .map((element) => ({
          element,
          label: (element.innerText || "").trim().replace(/\s+/g, " "),
          active: /ant-tabs-tab-active/i.test(
            typeof element.className === "string" ? element.className : ""
          ) || element.getAttribute("aria-selected") === "true",
        }))
        .filter((tab) => tab.label && tab.label.length <= 40);
      if (tabs.length < 2) continue;
      updateRunLog(
        `二级 Tab：${tabs.map((tab) => `${tab.label}${tab.active ? "*" : ""}`).join(" | ")}`,
        "info"
      );
      const index = tabs.findIndex((tab) => tab.active);
      if (index >= 0 && index + 1 < tabs.length) {
        return {
          element: tabs[index + 1].element,
          label: tabs[index + 1].label,
          sectionTab: true,
        };
      }
    }
    return null;
  }

  function nextSpeakingTask() {
    for (const doc of pageDocuments()) {
      const text = doc.body?.innerText || "";
      if (!/Read the conversation about/i.test(text)) continue;
      const target = [...doc.querySelectorAll("div, span, a, button")]
        .filter((element) => visible(element) &&
          !element.closest("#uca-panel, #freeocs-ucampus-panel") &&
          (element.innerText || "").trim() === "Speaking task" &&
          !element.querySelector("div, span, a, button"))
        .sort((left, right) =>
          left.getBoundingClientRect().top - right.getBoundingClientRect().top
        )[0];
      if (target) {
        return { element: target, label: "Speaking task", sectionTab: true };
      }
    }
    return null;
  }

  function menuLevels() {
    const viewportWidth = window.innerWidth || 1200;
    const levels = { 1: [], 2: [], 3: [], 4: [] };
    const content = [];
    for (const doc of pageDocuments()) {
      const candidates = [...doc.querySelectorAll(
        "[role='tab'], [class*='tab'], .pc-menu-node-name, .pc-slider-menu-micro"
      )];
      for (const element of candidates) {
        if (!visible(element) || element.closest("#uca-panel, #freeocs-ucampus-panel")) continue;
        const label = (element.innerText || "").trim().replace(/\s+/g, " ");
        if (!label || label.length > 40) continue;
        if (/^Module\s+\d+$/i.test(label)) continue;
        if (/^(目录|笔记)$/.test(label)) continue;
        if (element.querySelector(
          "[role='tab'], [class*='tab'], .pc-menu-node-name, .pc-slider-menu-micro"
        )) continue;
        const rect = element.getBoundingClientRect();
        if (!rect.width || !rect.height) continue;
        const item = {
          element,
          label,
          top: rect.top,
          left: rect.left,
          active: tabElementActive(element),
        };
        if (rect.left > viewportWidth * 0.6 ||
          element.closest("aside, [class*='sider'], [class*='slider'], .sidebar")) {
          levels[1].push({ ...item, level: 1 });
        } else if (rect.top < 320) {
          content.push(item);
        }
      }
    }

    const rows = [];
    for (const item of content) {
      let row = rows.find((candidate) => Math.abs(candidate.top - item.top) <= 14);
      if (!row) {
        row = { top: item.top, items: [] };
        rows.push(row);
      }
      row.items.push(item);
    }
    rows.sort((left, right) => left.top - right.top);
    rows.forEach((row, index) => {
      const level = Math.min(4, index + 2);
      for (const item of row.items) {
        levels[level].push({ ...item, level });
      }
    });

    for (const level of [1, 2, 3, 4]) {
      levels[level].sort((left, right) =>
        left.top - right.top || left.left - right.left
      );
    }
    return levels;
  }

  function nextMenuTarget() {
    const levels = menuLevels();
    const activeLevel = [4, 3, 2, 1].find((level) =>
      levels[level].some((item) => item.active)
    ) || 0;
    if (!activeLevel) return null;
    for (let level = activeLevel; level >= 2; level -= 1) {
      const items = levels[level];
      const index = items.findIndex((item) => item.active);
      if (index >= 0 && index + 1 < items.length) {
        const next = items[index + 1];
        return { element: next.element, label: next.label, sectionTab: true };
      }
    }
    return null;
  }

  function nextSectionTab() {
    const speaking = nextSpeakingTask();
    if (speaking) return speaking;
    const reading = nextReadingTab();
    if (reading) return reading;
    const practiceTask = nextPracticeTask();
    if (practiceTask) return practiceTask;
    const nested = nextNestedTab();
    if (nested) return nested;
    const menu = nextMenuTarget();
    if (menu) return menu;
    const tabs = contentTabs();
    if (tabs.length < 2) return null;
    updateRunLog(
      `检测到子板块：${tabs.map((tab) => `${tab.label}${tab.active ? "*" : ""}`).join(" | ")}`,
      "info"
    );
    const rows = [];
    for (const tab of tabs) {
      let row = rows.find((item) => Math.abs(item.top - tab.top) <= 12);
      if (!row) {
        row = { top: tab.top, tabs: [] };
        rows.push(row);
      }
      row.tabs.push(tab);
    }
    rows.sort((left, right) => left.top - right.top);
    for (const row of rows) {
      row.tabs.sort((left, right) => left.left - right.left);
    }

    let activeRowIndex = -1;
    let activeIndex = -1;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const found = rows[index].tabs.findIndex((tab) => tab.active);
      if (found >= 0) {
        activeRowIndex = index;
        activeIndex = found;
        break;
      }
    }
    if (activeRowIndex < 0 || activeIndex < 0) return null;

    const activeTab = rows[activeRowIndex].tabs[activeIndex];
    for (let rowIndex = activeRowIndex; rowIndex >= 0; rowIndex -= 1) {
      const row = rows[rowIndex];
      let index = rowIndex === activeRowIndex
        ? activeIndex
        : row.tabs.findIndex((tab) => tab.active);
      if (index < 0) {
        index = -1;
        for (let candidate = 0; candidate < row.tabs.length; candidate += 1) {
          if (row.tabs[candidate].left <= activeTab.left + 5) index = candidate;
        }
      }
      if (index >= 0 && index + 1 < row.tabs.length) {
        const next = row.tabs[index + 1];
        return { element: next.element, label: next.label, sectionTab: true };
      }
    }
    return null;
  }

  function practiceTabState() {
    const exists = pageDocuments().some((doc) =>
      practiceTabs(doc).some((element) =>
        (element.innerText || element.getAttribute("aria-label") || "")
          .trim().toLowerCase() === "practice"
      )
    );
    if (!exists) return "";
    return practiceTab() ? "mini-lecture" : "practice";
  }

  function courseTasks() {
    return pageDocuments().flatMap((doc) =>
      [...doc.querySelectorAll("[class*='taskItemContainer']")]
        .filter((element) => visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel"))
        .map((element) => ({
          element,
          label: element.querySelector("[class*='taskTypeName']")?.innerText
            ?.trim().replace(/\s+/g, " ").slice(0, 120) ||
            element.innerText?.trim()
              .replace(/\s+(?:必修|选修)?\s*(?:已完成|已通过|已掌握|未开始|未完成|进行中|学习中|待开始|待学习|继续学习)\s*$/, "")
              .replace(/\s+/g, " ").slice(0, 120) || "",
          status: element.querySelector(
            "[class*='taskStateContainer'], [class*='nodePassStateTip']"
          )?.innerText?.trim() || element.innerText?.trim() || "",
        }))
        .filter((task) => task.label)
    );
  }

  function isCourseDetailPage() {
    return /\/app\/cmgt\/resource-detail\/?/i.test(location.pathname);
  }

  function moduleTabs() {
    return pageDocuments().flatMap((doc) =>
      [...doc.querySelectorAll("[class*='tabItemContainer'], [role='tab']")]
        .filter((element) =>
          visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel") &&
          /^Module\s+\d+$/i.test((element.innerText || "").trim())
        )
    );
  }

  function isActiveModuleTab(tab) {
    const className = typeof tab.className === "string" ? tab.className : "";
    return tab.getAttribute("aria-selected") === "true" ||
      /\b(?:active|selected|current)\b|tabActive/i.test(className);
  }

  function unfinishedTasks(tasks) {
    return tasks.filter((task) =>
      !/已完成|已通过|已掌握/.test(task.status) &&
      /未开始|未完成|进行中|学习中|待开始|待学习|继续学习/.test(task.status)
    );
  }

  async function activateModuleTab(tab) {
    if (isActiveModuleTab(tab)) return;
    const label = (tab.innerText || "").trim();
    tab.click();
    for (let retry = 0; retry < 30; retry += 1) {
      await wait(200);
      const current = moduleTabs().find((item) =>
        (item.innerText || "").trim() === label
      );
      if (current && isActiveModuleTab(current)) {
        await wait(200);
        return;
      }
    }
    throw new Error(`切换到${label}失败，未能确认模块内容已更新。`);
  }

  async function findUnfinishedCourseTask() {
    const labels = moduleTabs().map((tab) => (tab.innerText || "").trim());
    if (!labels.length) {
      const unfinished = unfinishedTasks(courseTasks());
      return unfinished.find((task) => /进行中|学习中/.test(task.status)) ||
        unfinished[0] || null;
    }

    let firstUnstarted = null;
    let scannedTasks = 0;
    for (const label of labels) {
      const tab = moduleTabs().find((item) =>
        (item.innerText || "").trim() === label
      );
      if (!tab) throw new Error(`课程目录中未找到${label}。`);
      await activateModuleTab(tab);
      const tasks = await waitForCourseTasks();
      scannedTasks += tasks.length;
      const unfinished = unfinishedTasks(tasks);
      const inProgress = unfinished.find((task) => /进行中|学习中/.test(task.status));
      if (inProgress) {
        return {
          ...inProgress,
          module: label,
        };
      }
      if (!firstUnstarted && unfinished[0]) {
        firstUnstarted = {
          ...unfinished[0],
          module: label,
        };
      }
    }
    if (scannedTasks === 0) {
      throw new Error("课程目录已切换，但 5 秒内没有读到任何任务；页面可能仍在加载，请稍后重试。");
    }
    return firstUnstarted;
  }

  async function waitForCourseTasks(timeoutMs = 5000) {
    const signature = () => courseTasks()
      .map((task) => `${task.label}|${task.status}`)
      .join("\n");
    let last = signature();
    let stable = 0;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await wait(250);
      const current = signature();
      if (current && current === last) {
        stable += 1;
        if (stable >= 2) return courseTasks();
      } else {
        stable = 0;
        last = current;
      }
    }
    return courseTasks();
  }

  function consumePendingCourseStart() {
    const pending = gmGet(COURSE_START_KEY, null);
    if (!pending) return false;
    if (isCourseDetailPage()) {
      if (!Number.isFinite(pending.createdAt) ||
        Date.now() - pending.createdAt > 120000) {
        gmSet(COURSE_START_KEY, null);
      }
      return false;
    }
    gmSet(COURSE_START_KEY, null);
    if (!Number.isFinite(pending.createdAt) ||
      Date.now() - pending.createdAt > 120000) return false;
    return true;
  }

  async function startFromCourseDetail() {
    if (!isCourseDetailPage() || courseStartAttempted) return;
    courseStartAttempted = true;
    try {
      setStatus("正在扫描各模块的未完成课程…");
      const target = await findUnfinishedCourseTask();
      if (!target) {
        const message = "课程目录中没有检测到未完成项目。";
        setStatus(message);
        updateRunLog(message);
        return;
      }

      const label = `${target.module ? `${target.module} · ` : ""}${target.label}`;
      const previousQuestion = currentQuestion();
      setStatus(`找到未完成项目：${label}，正在打开…`);
      gmSet(COURSE_START_KEY, {
        createdAt: Date.now(),
        sourceUrl: location.href,
        label,
      });
      target.element.click();

      for (let retry = 0; retry < 60; retry += 1) {
        await wait(500);
        if (!isCourseDetailPage() || courseTasks().length === 0 ||
          answerControls().type !== "unsupported" || videoForAutomation().video) {
          gmSet(COURSE_START_KEY, null);
          automationIntro = `自动定位到未完成项目：${label}`;
          await runAutomation();
          return;
        }
      }

      gmSet(COURSE_START_KEY, null);
      const message = `已找到“${label}”，但点击后未检测到课程学习页面；自动流程已停止。`;
      setStatus(message, true);
      updateRunLog(message, "error");
      await reportUnknown(previousQuestion || label, message);
    } catch (error) {
      gmSet(COURSE_START_KEY, null);
      const message = `查找未完成课程失败：${error.message}`;
      setStatus(message, true);
      updateRunLog(message, "error");
      console.error("[UCampus Assistant] 无法定位未完成课程", error);
    }
  }

  function activeCourseTask(tasks) {
    const activeNode = pageDocuments().flatMap((doc) =>
      [...doc.querySelectorAll("[class*='ipublishNode_1'], [aria-current='step'], [aria-current='page']")]
    ).find((element) => visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel"));
    if (activeNode) {
      const selectedTask = activeNode.matches("[class*='taskItemContainer']")
        ? activeNode
        : activeNode.closest("[class*='taskItemContainer']") ||
          activeNode.querySelector("[class*='taskItemContainer']");
      const match = tasks.findIndex((task) => task.element === selectedTask);
      if (match >= 0) return match;
    }

    const highlighted = tasks.filter((task) => {
      const background = getComputedStyle(task.element).backgroundColor;
      return background === "rgb(245, 247, 250)" || background === "rgb(245, 245, 245)";
    });
    return highlighted.length === 1
      ? tasks.findIndex((task) => task === highlighted[0])
      : -1;
  }

  function nextCourseTask() {
    const tasks = courseTasks();
    const currentIndex = activeCourseTask(tasks);
    if (currentIndex < 0 || currentIndex + 1 >= tasks.length) return null;
    return tasks[currentIndex + 1];
  }

  function looksLikeQuestion(text) {
    return /[?？]\s*(?:$|\n)|_{2,}|（\s*\）|\(\s*\)|选择(?:正确|最佳|最合适)|填入(?:正确|合适)|which of the following|choose the (?:correct|best)|select the (?:correct|best)|complete the sentence/i
      .test(text);
  }

  function currentStepKey() {
    const video = videoForAutomation().video;
    const tasks = courseTasks();
    const taskIndex = activeCourseTask(tasks);
    const task = tasks[taskIndex]?.label || "";
    const content = currentQuestion();
    const media = video
      ? video.currentSrc || video.src || video.querySelector("source[src]")?.src || ""
      : "";
    return [location.href, task, practiceTabState(), media, content].join("|").slice(0, 16000);
  }

  function nextLearningTarget(preferCatalog = false) {
    const sectionTab = nextSectionTab();
    if (sectionTab) return sectionTab;
    const practice = practiceTab();
    if (!preferCatalog && practice) return { element: practice, label: "Practice" };
    if (preferCatalog) {
      const catalog = nextCatalogSection();
      if (catalog) return { element: catalog.element, label: catalog.label, catalog: true };
    }
    const nextButton = nextQuestionButton();
    if (nextButton) {
      const label = (nextButton.innerText || nextButton.getAttribute("aria-label") ||
        nextButton.getAttribute("title") || "下一题").trim();
      return { element: nextButton, label };
    }
    const catalog = nextCatalogSection();
    if (catalog) return { element: catalog.element, label: catalog.label, catalog: true };
    const task = isCourseDetailPage() ? nextCourseTask() : null;
    if (task) return { element: task.element, label: task.label, task: true };
    return null;
  }

  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function dismissBlockingDialog() {
    for (const doc of pageDocuments()) {
      const labels = new Set(["我知道了", "知道了", "我知道了。"]);
      const interactive = [...doc.querySelectorAll("button, [role='button'], a")]
        .filter((element) => visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel"))
        .find((element) => labels.has((element.innerText || "").trim()));
      if (interactive) {
        interactive.click();
        return true;
      }
      const fallback = [...doc.querySelectorAll("div, span")]
        .filter((element) => visible(element) && !element.closest("#uca-panel, #freeocs-ucampus-panel"))
        .find((element) => {
          const text = (element.textContent || "").trim();
          if (!labels.has(text)) return false;
          return ![...element.children].some((child) =>
            labels.has((child.textContent || "").trim())
          );
        });
      if (fallback) {
        fallback.click();
        return true;
      }
    }
    return false;
  }

  function catalogSections() {
    for (const doc of pageDocuments()) {
      const nodes = [...doc.querySelectorAll(".pc-slider-menu-micro")].filter(visible);
      if (!nodes.length) continue;
      return nodes
        .map((element) => ({
          element,
          label: element.querySelector(".pc-menu-node-name")?.getAttribute("title") ||
            element.innerText?.trim() || "",
          active: element.classList.contains("pc-menu-activity") ||
            Boolean(element.closest(".pc-menu-activity")) ||
            Boolean(element.querySelector(".pc-menu-activity")),
        }))
        .filter((item) => item.label);
    }
    return [];
  }

  function nextCatalogSection() {
    const sections = catalogSections();
    const index = sections.findIndex((item) => item.active);
    if (index < 0 || index + 1 >= sections.length) return null;
    const next = sections[index + 1];
    return {
      ...next,
      element: next.element.querySelector(".pc-menu-node-name") || next.element,
    };
  }

  function isDiscussionPage() {
    for (const doc of pageDocuments()) {
      const crumbs = [...doc.querySelectorAll(".ant-breadcrumb li")];
      const last = (crumbs[crumbs.length - 1]?.innerText || "").trim();
      if (/^Discussion$/i.test(last)) return true;
      const board = doc.querySelector("[id^='uai-bbs-'], [class*='discussion-board']");
      if (board && visible(board) &&
        /Discussion|讨论/i.test((board.innerText || "").slice(0, 200))) return true;
      const editor = doc.querySelector(
        "textarea[placeholder*='评论'], [contenteditable='true'][data-placeholder*='评论']"
      );
      if (editor && visible(editor)) return true;
      const commentList = doc.querySelector(
        "[class*='comment-list'], [class*='commentList'], [class*='comment_list']"
      );
      if (commentList && visible(commentList) &&
        /全部评论|回复/.test(commentList.innerText || "")) return true;
    }
    return false;
  }

  function looksLikeFillPage() {
    for (const doc of pageDocuments()) {
      const text = (doc.body?.innerText || "").slice(0, 4000);
      if (/Complete the following summary|Fill in the (?:blank|blanks)|填空题|fill[- ]in[- ]the[- ]blank/i.test(text)) {
        return true;
      }
      if (doc.querySelector(
        ".question-common-abs-scoop, .comp-scoop-reply, .comp-abs-input, .fe-scoop"
      )) {
        return true;
      }
    }
    return false;
  }

  async function waitForFillFields(timeoutMs = 10000) {
    if (!looksLikeFillPage()) return false;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && automationRunning) {
      const controls = answerControls();
      if (["blank", "blanks", "essays", "essay"].includes(controls.type)) {
        updateRunLog(`填空控件已加载：${controls.type}`, "info");
        return true;
      }
      await wait(500);
    }
    if (!automationRunning) return false;
    updateRunLog("等待填空控件超时，继续检测页面", "warn");
    return false;
  }

  async function waitForQuestionReady(attempts = 3, delay = 2000) {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (dismissBlockingDialog()) await wait(500);
      const question = currentQuestion();
      const controls = answerControls();
      const video = videoForAutomation();
      if (looksLikeFillPage() &&
        !["blank", "blanks", "essays"].includes(controls.type)) {
        if (attempt < attempts) {
          updateRunLog("填空页控件尚未加载，等待…", "info");
          await wait(delay);
        }
        continue;
      }
      if ((question && looksLikeQuestion(question)) ||
        controls.type !== "unsupported" ||
        video.video ||
        isDiscussionPage() ||
        pageActionButton() ||
        nextQuestionButton() ||
        nextCatalogSection() ||
        contentTabs().length > 0 ||
        unsupportedVideoSignal()) {
        return true;
      }
      if (attempt < attempts) {
        updateRunLog(`页面题目/内容尚未加载，等待后重试（${attempt}/${attempts}）`, "info");
        await wait(delay);
      }
    }
    return false;
  }

  async function answerDiscussion() {
    const discussionPageKey = `page|${location.href}`;
    if (submittedDiscussionKeys.has(discussionPageKey)) {
      updateRunLog("当前讨论页已经发布过评论，跳过重复生成", "warn");
      return false;
    }
    for (const doc of pageDocuments()) {
      const editor = doc.querySelector(
        "textarea[placeholder*='评论'], [contenteditable='true'][data-placeholder*='评论']"
      );
      if (!editor || !visible(editor)) continue;
      const text = (doc.body.innerText || "")
        .split("全部评论")[0]
        .trim()
        .slice(0, 1500);
      if (!text) continue;
      setStatus("正在生成讨论答案…");
      const result = await request("/api/answer", {
        question: text,
        question_type: "discussion",
      });
      if (!result.answer) return false;
      const normalizedAnswer = String(result.answer).replace(/\s+/g, "").slice(0, 160);
      const comments = [...doc.querySelectorAll(
        "[class*='comment-list'], [class*='commentList'], [class*='comment_list'], " +
        "[class*='discussion-cloud-recordList-item']"
      )].map((element) => String(element.innerText || "").replace(/\s+/g, "")).join("");
      if (normalizedAnswer && comments.includes(normalizedAnswer)) {
        updateRunLog("讨论区已存在相同评论，跳过重复发布", "warn");
        return false;
      }
      writeText(editor, result.answer.slice(0, 500));
      await wait(500);
      updateRunLog("讨论答案已填入；未自动发布", "success", true);
      setStatus("讨论答案已填入，等待手动发布");
      return true;
    }
    return false;
  }

  function pageActionButton() {
    const labels = ["下一题", "下一步", "继续", "继续学习", "完成并继续"];
    let best = null;
    for (const doc of pageDocuments()) {
      for (const element of doc.querySelectorAll("button, [role='button'], a")) {
        const label = (element.innerText || "").trim().replace(/\s+/g, "");
        if (!labels.includes(label)) continue;
        if (!visible(element) || element.closest("#uca-panel, #freeocs-ucampus-panel")) continue;
        if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
        const rect = element.getBoundingClientRect();
        if (rect.left > (window.innerWidth || 1200) * 0.85) continue;
        if (!best || rect.top > best.top) best = { element, label, top: rect.top };
      }
    }
    return best ? { element: best.element, label: best.label } : null;
  }

  function findSubmitButton() {
    const labels = ["提交", "交卷", "保存并提交", "提交答案", "确定提交", "提交作业", "发布"];
    for (const doc of pageDocuments()) {
      for (const element of doc.querySelectorAll("button, [role='button'], a")) {
        const label = (element.innerText || "").trim().replace(/\s+/g, "");
        if (!labels.includes(label)) continue;
        if (!visible(element) || element.closest("#uca-panel, #freeocs-ucampus-panel")) continue;
        if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
        return { element, label };
      }
    }
    return null;
  }

  function findSubmitConfirmButton() {
    const labels = new Set(["确定", "确 定", "确认", "确定提交", "确认提交", "继续", "提交"]);
    for (const doc of pageDocuments()) {
      if (!visibleDocument(doc)) continue;
      // A page can have a visible bottom "提交" button behind the modal.
      // Prefer buttons inside the visible dialog, otherwise we click the
      // underlying submit button forever and the dialog never closes.
      const dialogs = [...doc.querySelectorAll(
        "[role='dialog'], .ant-modal, .ant-modal-confirm, .ant-modal-wrap"
      )].filter((element) => visible(element));
      for (const dialog of dialogs) {
        for (const element of dialog.querySelectorAll("button, a, [role='button'], .ant-btn")) {
          if (!visible(element) || element.disabled ||
            element.getAttribute("aria-disabled") === "true") continue;
          const label = (element.innerText || element.getAttribute("aria-label") || "")
            .trim().replace(/\s+/g, "");
          if (!label || /取消|关闭|返回|再想想/.test(label)) continue;
          if (labels.has(label)) return { element, label };
        }
      }
    }
    return null;
  }

  function findDiscussionPublishButton(editor) {
    let root = editor;
    for (let depth = 0; depth < 7 && root; depth += 1, root = root.parentElement) {
      const buttons = [...root.querySelectorAll("button, [role='button'], a, .ant-btn")]
        .filter((element) =>
          visible(element) &&
          !element.closest("#freeocs-ucampus-panel, #uca-panel") &&
          !element.disabled &&
          element.getAttribute("aria-disabled") !== "true"
        );
      const publish = buttons.find((element) =>
        (element.innerText || "").trim().replace(/\s+/g, "") === "发布"
      );
      if (publish) return { element: publish, label: "发布" };
    }
    return null;
  }

  function isManualDragPage() {
    for (const doc of pageDocuments()) {
      if (!visibleDocument(doc)) continue;
      // Speaking/oral upload pages also mention "drag files here"; they are
      // handled by the oral flow, never by the drag detector.
      if (doc.querySelector("input[type='file']")) continue;
      const controls = [...doc.querySelectorAll(
        "[draggable='true'], .drag-item, [class*='drag-item'], [class*='dragItem'], " +
        "[class*='sortable-item'], [class*='sortable-list-item'], " +
        "[class*='sort-item'], [class*='sortItem'], [class*='dnd-item'], " +
        "[class*='drop-zone'], [class*='drag-']"
      )].filter((element) =>
        visible(element) && !element.closest("#freeocs-ucampus-panel, #uca-panel")
      );
      if (controls.length) return true;
      // innerText respects display:none, so hidden old tabs/frames cannot
      // trigger the drag detector.  Strip our own panel text explicitly.
      const panelText = doc.getElementById?.("freeocs-ucampus-panel")?.innerText || "";
      const text = (doc.body?.innerText || "").replace(panelText, "").slice(0, 6000);
      // "将音频拖动到此处" is an upload dropzone, not a drag question.
      if (!/拖动(?:下列|以下|项目|排序|句子)|拖拽(?:下列|以下|项目)|拖动排序|按顺序拖动|reorder|drag\s+(?:the\s+)?(?:items|sentences|following)/i.test(text)) {
        continue;
      }
      if (hasSubmitAction() || doc.querySelector("[class*='question'], [class*='match']")) {
        return true;
      }
    }
    return false;
  }

  async function autoSubmitPage(reason = "自动提交") {
    if (isManualDragPage()) {
      updateRunLog("检测到拖动/排序题，需要用户手动拖动，已跳过自动提交", "warn");
      setStatus("拖动/排序题需要手动完成，未自动提交。");
      return false;
    }
    if (answerControls().type === "matching") {
      updateRunLog("检测到匹配/排序下拉题，需要用户手动确认，已跳过自动提交", "warn");
      setStatus("匹配题需要手动选择，未自动提交。");
      return false;
    }
    if (isDiscussionPage()) {
      const editor = pageDocuments().map((doc) => doc.querySelector(
        "textarea[placeholder*='评论'], [contenteditable='true'][data-placeholder*='评论']"
      )).find((element) => element && visible(element));
      const text = editor ? String(editor.value || editor.textContent || "").trim() : "";
      if (!text) {
        updateRunLog("讨论编辑器为空，跳过自动发布", "warn");
        return false;
      }
      const key = `${location.href}|${text.replace(/\s+/g, " ").trim()}`;
      const pageKey = `page|${location.href}`;
      if (submittedDiscussionKeys.has(pageKey) || submittedDiscussionKeys.has(key)) {
        updateRunLog("该讨论页已发布过评论，跳过重复发布", "warn");
        return true;
      }
      const publish = findDiscussionPublishButton(editor);
      if (publish) {
        submittedDiscussionKeys.add(pageKey);
        submittedDiscussionKeys.add(key);
        gmSet("ucaDiscussionSubmitKeys", [...submittedDiscussionKeys].slice(-50));
        armSubmitHandoff("发布");
        updateRunLog("自动提交：发布讨论评论", "warn");
        publish.element.click();
        await wait(900);
        return true;
      }
      updateRunLog("未找到当前评论的发布按钮，跳过发布", "warn");
      return false;
    }
    const submit = findSubmitButton();
    if (submit) {
      // Arm the existing post-submit watcher so the next module starts
      // automatically after the page changes.
      armSubmitHandoff(submit.label);
      updateRunLog(`自动提交：点击“${submit.label}”`, "warn");
      submit.element.click();
      await wait(900);
      const confirm = findSubmitConfirmButton();
      if (confirm && submitDialogVisible()) {
        updateRunLog(`自动提交：点击确认“${confirm.label}”`, "warn");
        confirm.element.click();
        await wait(900);
      }
      await wait(700);
      return true;
    }
    if (submitDialogVisible()) {
      const confirm = findSubmitConfirmButton();
      if (confirm) {
        armSubmitHandoff("提交确认");
        updateRunLog(`自动提交：确认“${confirm.label}”`, "warn");
        confirm.element.click();
        await wait(900);
        return true;
      }
    }
    updateRunLog(`自动提交未找到提交按钮：${reason}`, "warn");
    return false;
  }

  function submitDialogVisible() {
    for (const doc of pageDocuments()) {
      const text = doc.body?.innerText || "";
      if (/确定提交|第一次作答|仅记录第一次|确认交卷|确定要交卷/.test(text)) return true;
    }
    return false;
  }

  function hasSubmitAction() {
    if (nextQuestionButton()) return false;
    return Boolean(findSubmitButton()) || submitDialogVisible();
  }

  async function waitingForManual(reason, allowAutoSubmit = true) {
    if (allowAutoSubmit && autoSubmitEnabled && /提交|交卷|发布/.test(reason)) {
      if (await autoSubmitPage(reason)) return;
    }
    manualStop = true;
    runHalted = true;
    automationRunning = false;
    setStatus(reason);
    updateRunLog(reason, "warn");
    try {
      await request("/api/automation/report", {
        status: reason,
        running: false,
        url: location.href,
        title: document.title,
        completed: runState.completed,
      });
    } catch (_) {
      // The UI will show the offline state.
    }
    try {
      await request("/api/module/ucampus/finish", { reason });
    } catch (_) {
      // Ignore; the page agent is stopping anyway.
    }
  }

  function controlsAnswered(controls) {
    if (!controls) return false;
    if (controls.type === "multi-choice" && controls.group &&
      typeof controls.group.querySelector === "function") {
      return Boolean(controls.group.querySelector(
        "[class*='selected'], [class*='checked'], input:checked"
      ));
    }
    if (controls.type === "choice" && controls.radioGroup) {
      return Boolean(controls.options?.some((option) => option.input.checked));
    }
    if (controls.type === "choice" && controls.group &&
      typeof controls.group.querySelector === "function") {
      return Boolean(controls.group.querySelector(
        "input:checked, [aria-checked='true'], [class*='checked'], [class*='selected']"
      ));
    }
    if (controls.type === "dropdown") {
      const empty = controls.dropdown?.element?.querySelector(".user-answer.empty") ||
        controls.dropdown?.element?.querySelector(".user-answer-text")?.classList.contains("empty");
      if (empty) return false;
      const text = (controls.dropdown?.element?.querySelector(".user-answer-text")
        ?.innerText || controls.dropdown?.element?.innerText || "").trim();
      // U校园 shows "点击选择" for an untouched dropdown.
      return Boolean(text) && !/请选择|点击选择|选择|choose|select/i.test(text);
    }
    if (controls.fields?.length) {
      return controls.fields.every((field) =>
        (field.value || field.textContent || "").trim()
      );
    }
    return false;
  }

  async function confirmSubmitDialog() {
    return submitDialogVisible();
  }

  async function clickPageAction() {
    const action = pageActionButton();
    if (!action) {
      if (hasSubmitAction()) {
        if (autoSubmitEnabled) {
          if (await autoSubmitPage("已填完")) return true;
        }
        await waitingForManual("已填完，等待手动提交");
      }
      return false;
    }
    setStatus(`正在点击：${action.label}`);
    const submittedKey = currentStepKey();
    action.element.click();
    await wait(1500);
    submittedSteps.add(submittedKey);
    pendingNavigation = true;
    updateRunLog(`已点击：${action.label}`, "success", true);
    // Do not click a second "next" automatically: after the first click the
    // next page may be a fill/ordering page whose controls have not rendered
    // yet.  The main loop will inspect that page and answer it.
    return true;
  }

  function installDubbingMic() {
    const pageWindow = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    const media = pageWindow.navigator?.mediaDevices;
    if (!media) return null;
    if (!pageWindow.__ucaMicPatched) {
      const original = media.getUserMedia?.bind(media);
      media.getUserMedia = async (constraints) =>
        pageWindow.__ucaDubbingStream || original(constraints);
      pageWindow.__ucaMicPatched = true;
    }
    return pageWindow;
  }

  async function resumeAudioContext(context) {
    if (!context || context.state !== "suspended") return;
    try {
      // Autoplay policy can keep resume() pending forever without a gesture.
      await Promise.race([context.resume(), wait(1200)]);
    } catch (_) {
      // Keep going; decode/playback may still work.
    }
  }

  function dubbingScore(item) {
    const element = item.item?.querySelector(".score, [class*='score']");
    const text = (element?.innerText || "").trim();
    const match = text.match(/\d+/);
    return match ? Number(match[0]) : null;
  }

  async function waitDubbingScores(items, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const scores = items.map(dubbingScore);
      if (scores.every((value) => value !== null && Number(value) > 0)) return scores;
      dismissRecordingError();
      await wait(700);
    }
    return items.map(dubbingScore);
  }

  function dismissRecordingError() {
    let clicked = false;
    for (const doc of pageDocuments()) {
      const dialogs = [...doc.querySelectorAll(
        ".ant-modal, [class*='modal'], [class*='dialog'], [role='dialog']"
      )].filter((element) =>
        visible(element) && !element.closest("#freeocs-ucampus-panel, #uca-panel")
      );
      for (const dialog of dialogs) {
        const text = dialog.innerText || "";
        if (!/录音启动超时|录音失败|录音未|录音上传失败|请稍后重试/.test(text)) continue;
        const button = [...dialog.querySelectorAll("button, [role='button'], a")]
          .find((element) => visible(element) &&
            /^(确定|知道了|我知道了)$/.test(
              (element.innerText || "").replace(/\s+/g, "")
            ));
        if (button) {
          button.click();
          updateRunLog("已自动关闭录音错误弹窗", "warn");
          clicked = true;
        }
      }
    }
    return clicked;
  }

  async function recordDubbingItem(item) {
    const blob = await request("/api/speech", { text: item.text }, "blob");
    const pageWindow = installDubbingMic();
    if (!pageWindow) throw new Error("页面没有可用的麦克风接口。");
    const AudioContextClass = pageWindow.AudioContext || pageWindow.webkitAudioContext;
    if (!AudioContextClass) throw new Error("页面不支持 Web Audio。");
    const context = new AudioContextClass();
    await resumeAudioContext(context);
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    const destination = context.createMediaStreamDestination();
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(destination);
    source.connect(context.destination);
    pageWindow.__ucaDubbingStream = destination.stream;
    // Start the page recorder first.  Starting the audio source before the
    // recorder has consumed the synthetic mic stream drops the first part of
    // the word and makes scoring fail.
    item.button.click();
    // U校园 的录音控件通常需要约 1 秒才真正进入录制状态；固定等 2 秒，
    // 避免合成音频在录音开始前被播放掉。
    await wait(2000);
    updateRunLog(`开始录制第 ${item.index + 1} 句：${item.text.slice(0, 60)}`, "info");
    source.start();
    await wait(buffer.duration * 1000 + 500);
    item.button.click();
    await wait(2500);
    try { source.stop(); } catch (_) {}
    await context.close();
    pageWindow.__ucaDubbingStream = null;
    // U校园 评分是异步返回的；马上读通常是 0/空。等评分出现后再判断。
    const measured = await waitDubbingScores([item], 12000);
    const score = Number(measured[0] || 0);
    const scoreText = (item.item?.querySelector(".score")?.innerText || "").trim();
    updateRunLog(`第 ${item.index + 1} 句录制完成${scoreText ? `，得分 ${scoreText}` : ""}`, "success", true);
    return score;
  }

  async function answerDubbing(controls) {
    const pending = (controls.items || []).filter((item) => {
      if (!item.text) return false;
      const score = dubbingScore(item);
      return score === null || Number(score) <= 0;
    });
    if (!pending.length) {
      updateRunLog("朗读项均已有评分，直接继续", "info");
      return true;
    }
    updateRunLog(`准备朗读 ${pending.length} 句（语音合成 → 模拟麦克风）`, "info");
    const scores = [];
    for (const item of pending) {
      if (!automationRunning) return false;
      let score = 0;
      try {
        score = await recordDubbingItem(item);
      } catch (error) {
        updateRunLog(`第 ${item.index + 1} 句录音异常：${error.message}`, "warn");
      }
      if (!score && automationRunning) {
        dismissRecordingError();
        await wait(1200);
        updateRunLog(`第 ${item.index + 1} 句未录上，正在重录`, "warn");
        try {
          score = await recordDubbingItem(item);
        } catch (error) {
          updateRunLog(`第 ${item.index + 1} 句重录失败：${error.message}`, "error");
        }
      }
      scores.push(score);
      await wait(600);
    }
    dismissRecordingError();
    await wait(800);
    // Give the page a final chance to finish asynchronous scoring.
    await waitDubbingScores(controls.items || [], 10000);
    const failed = (controls.items || []).filter((item) => {
      const score = dubbingScore(item);
      return score === null || Number(score) <= 0;
    });
    const scored = scores.filter((value) => Number.isFinite(value) && value > 0);
    if (scored.length) {
      const average = scored.reduce((sum, value) => sum + value, 0) / scored.length;
      updateRunLog(
        `朗读完成：${scored.join(", ")}，平均 ${average.toFixed(1)}`,
        average >= 60 ? "success" : "warn"
      );
    }
    if (failed.length) {
      updateRunLog(`提交前复检：仍有 ${failed.length} 句未录上，已停止自动提交`, "error");
      await waitingForManual("朗读录音未全部成功，请手动重录后提交", false);
      return false;
    }
    if (!automationRunning) return false;
    await clickPageAction();
    return true;
  }

  async function answerRoleplay(controls) {
    const doc = controls.doc;
    const text = doc.body?.innerText || "";
    const chosenMatch = /Choose a role\s*[：:]\s*(Janet|Porter)/i.exec(text);
    let role = chosenMatch ? chosenMatch[1] : "";
    if (!role) {
      const roleCard = [...doc.querySelectorAll("div, span, button")]
        .find((element) => visible(element) &&
          /^(Janet|Porter)$/i.test((element.innerText || "").trim()) &&
          !element.querySelector("div, span, button"));
      if (roleCard) {
        role = roleCard.innerText.trim();
        roleCard.click();
        await wait(1200);
      }
    }
    if (!role) throw new Error("无法确定角色扮演角色。");

    const lines = text.split(/\n+/).map((item) => item.trim()).filter(Boolean);
    const scoreIndex = lines.lastIndexOf("Score");
    const dialogue = [];
    for (let index = scoreIndex + 1; index < lines.length - 1; index += 1) {
      if (!/^(Janet|Porter)$/i.test(lines[index])) continue;
      const next = lines[index + 1];
      if (!next || /^(Janet|Porter)$/i.test(next)) continue;
      dialogue.push({ role: lines[index], text: next });
    }
    const learnerLines = dialogue.filter((item) =>
      item.role.toLowerCase() === role.toLowerCase()
    );
    const mic = [...doc.querySelectorAll(
      "img[alt='录音'], img[help='录音'], [class*='record']"
    )].find(visible);
    if (!mic) throw new Error("未找到角色扮演麦克风按钮。");
    updateRunLog(`角色扮演：${role}，共 ${learnerLines.length} 句`, "info");

    const pageWindow = installDubbingMic();
    const AudioContextClass = pageWindow.AudioContext || pageWindow.webkitAudioContext;
    const context = new AudioContextClass();
    await resumeAudioContext(context);
    const buffers = [];
    for (const line of learnerLines) {
      const blob = await request("/api/speech", {
        text: line.text,
        output_format: "mp3",
      }, "blob");
      buffers.push(await context.decodeAudioData(await blob.arrayBuffer()));
    }
    const gap = 0.7;
    const total = buffers.reduce((sum, item) => sum + item.duration, 0) +
      gap * Math.max(0, buffers.length - 1);
    const combined = context.createBuffer(1, Math.ceil(total * context.sampleRate),
      context.sampleRate);
    let offset = 0;
    for (const buffer of buffers) {
      combined.getChannelData(0).set(buffer.getChannelData(0),
        Math.floor(offset * context.sampleRate));
      offset += buffer.duration + gap;
    }
    const destination = context.createMediaStreamDestination();
    const source = context.createBufferSource();
    source.buffer = combined;
    source.connect(destination);
    pageWindow.__ucaDubbingStream = destination.stream;

    mic.click();
    await wait(600);
    source.start();
    updateRunLog(`开始录制角色扮演，时长约 ${Math.round(total)} 秒`, "info");
    await wait(total * 1000 + 1800);
    mic.click();
    await wait(5000);
    try { source.stop(); } catch (_) {}
    await context.close();
    pageWindow.__ucaDubbingStream = null;
    dismissRecordingError();
    await wait(500);

    const scores = [...doc.querySelectorAll("*")]
      .filter((element) => {
        const value = (element.innerText || "").trim();
        return /^\d{1,3}$/.test(value) && !element.querySelector("*") &&
          element.getBoundingClientRect().left < 110 &&
          element.getBoundingClientRect().width > 0;
      })
      .map((element) => Number(element.innerText.trim()))
      .filter((value) => value <= 100);
    const average = scores.length
      ? scores.reduce((sum, value) => sum + value, 0) / scores.length
      : 0;
    updateRunLog(`角色扮演得分：${scores.join(", ")}，平均 ${average.toFixed(1)}`,
      average >= 75 ? "success" : "error", true);
    if (average < 75) {
      throw new Error(`角色扮演平均分 ${average.toFixed(1)}，低于 75，未提交。`);
    }
    await clickPageAction();
  }

  async function waitForUploadResult(doc, timeoutMs = 30000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const text = doc.body?.innerText || "";
      if (/上传失败|文件上传失败|上传出错/.test(text)) return false;
      const item = doc.querySelector(
        ".ant-upload-list-item, [class*='upload-list'] [class*='item']"
      );
      if (item) {
        const className = typeof item.className === "string" ? item.className : "";
        if (/done|success/i.test(className) || /上传成功/.test(text)) return true;
        if (/error|fail/i.test(className)) return false;
      }
      await wait(1000);
    }
    return !/上传失败|文件上传失败|上传出错/.test(doc.body?.innerText || "");
  }

  function collectFallbackElements() {
    const result = [];
    let index = 0;
    for (const doc of pageDocuments()) {
      const nodes = [...doc.querySelectorAll(
        "button, a, input, textarea, select, " +
        "[role='button'], [role='radio'], [role='checkbox'], [role='tab'], " +
        "[role='option'], [role='switch'], [contenteditable='true'], [onclick], " +
        ".option, .ant-dropdown-trigger, .scoop-select-wrapper, .input-item, " +
        "[class*='btn'], [class*='button'], [class*='tab'], [class*='choice'], " +
        "[class*='select'], [class*='record'], [class*='play'], [class*='audio'], " +
        "[class*='item']"
      )];
      for (const element of nodes) {
        if (!visible(element) || element.closest("#uca-panel, #freeocs-ucampus-panel")) continue;
        if (element.disabled || element.getAttribute("aria-disabled") === "true") continue;
        const tag = element.tagName.toLowerCase();
        const role = (element.getAttribute("role") || "").toLowerCase();
        let kind = "clickable";
        if (tag === "input") {
          kind = ["radio", "checkbox"].includes(element.type) ? element.type : "input";
        } else if (tag === "textarea" || element.isContentEditable) {
          kind = "input";
        } else if (tag === "select") {
          kind = "select";
        } else if (role === "radio" || role === "checkbox") {
          kind = role;
        }
        const label = (element.innerText || element.getAttribute("aria-label") ||
          element.getAttribute("title") || element.value ||
          element.getAttribute("placeholder") || "").trim().slice(0, 300);
        element.setAttribute("data-freeocs-el", String(index));
        result.push({
          index,
          tag,
          kind,
          type: element.type || "",
          text: label,
          value: String(element.value || "").slice(0, 500),
          placeholder: element.getAttribute("placeholder") || "",
          aria: element.getAttribute("aria-label") || "",
          role: element.getAttribute("role") || "",
          id: element.id || "",
          className: typeof element.className === "string" ? element.className.slice(0, 240) : "",
          checked: Boolean(element.checked),
          disabled: Boolean(element.disabled),
        });
        index += 1;
        if (index >= 100) break;
      }
      if (index >= 100) break;
    }
    return result;
  }

  function findFallbackElement(index) {
    const value = String(index);
    for (const doc of pageDocuments()) {
      const element = doc.querySelector(`[data-freeocs-el="${value}"]`);
      if (element) return element;
    }
    return null;
  }

  function isUnsafeActionLabel(text) {
    return /提交|交卷|发布|评分提交|确定提交|保存并提交/.test(String(text || ""));
  }

  async function runWebFallback(question, reason, options = {}) {
    const elements = collectFallbackElements();
    const interactive = elements.some((item) =>
      ["input", "radio", "checkbox", "select"].includes(item.kind)
    );
    // Do not require standard interactive elements: many U校园 pages use
    // custom div/span controls.  The full HTML/text is still useful to AI.
    if (!elements.length && !question && !interactive) return false;
    const clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll("#freeocs-ucampus-panel, #freeocs-ucampus-panel-style")
      .forEach((element) => element.remove());
    const html = clone.outerHTML.slice(0, 1_500_000);
    const text = (document.body?.innerText || "").slice(0, 12000);
    const payload = {
      url: location.href,
      title: document.title,
      reason: reason || "未识别题型",
      question: question || "",
      question_type: "unsupported",
      html,
      text,
      elements,
      force_action: Boolean(options.explicit) && !options.reportOnly,
      report_only: Boolean(options.reportOnly),
    };
    let pagePath = "";
    try {
      const saved = await request("/api/module/ucampus/save-page", payload);
      pagePath = saved?.page_path || "";
      if (pagePath) updateRunLog(`已保存页面供开发：${pagePath}`, "info");
    } catch (error) {
      updateRunLog(`保存不支持页面失败：${error.message}`, "warn");
    }
    const estimate = Math.max(1, Math.ceil((html.length + text.length) / 4));
    const message = options.reportOnly
      ? [
          `这可能会消耗约 ${estimate.toLocaleString()} tokens。`,
          "感谢您对开源项目的支持。",
          "报告生成后，请在模块页点击“向开发者发送报告”提交。",
          "是否继续？",
        ].join("\n\n")
      : [
          "AI 网页兜底会把当前页面内容发送给模型，可能消耗较多 token。",
          `预计输入约 ${estimate.toLocaleString()} tokens（仅估算）。`,
          "是否继续？",
        ].join("\n\n");
    const confirmed = typeof window.confirm === "function" ? window.confirm(message) : false;
    if (!confirmed) {
      updateRunLog("已取消 AI 网页兜底，未发送给模型", "warn");
      return false;
    }
    updateRunLog(
      options.reportOnly
        ? "用户确认生成兼容性报告"
        : `用户确认 AI 网页兜底：${reason || "未识别题型"}`,
      "info"
    );
    let response;
    try {
      response = await request("/api/module/ucampus/answer-page", {
        ...payload,
        page_path: pagePath,
      });
    } catch (error) {
      updateRunLog(`AI 网页兜底请求失败：${error.message}`, "error");
      return false;
    }
    if (response?.page_path) {
      updateRunLog(`页面记录：${response.page_path}`, "info");
    }
    if (response?.report) {
      setPanelAnswer(response.report, options.reportOnly ? "兼容性报告" : "AI 开发者报告");
      setStatus(
        options.reportOnly
          ? "兼容性报告已生成；请到模块页点击“向开发者发送报告”。"
          : "AI 已生成页面分析报告；请查看面板和本地报告。"
      );
    }
    if (response?.report_zip) {
      updateRunLog(`AI 报告 zip：${response.report_zip}`, "success");
    }
    if (options.reportOnly) {
      if (response?.report || response?.report_zip) {
        updateRunLog("兼容性报告生成完成，未执行任何页面操作", "success");
        return true;
      }
      updateRunLog("兼容性报告生成失败", "error");
      return false;
    }
    const actions = Array.isArray(response?.actions) ? response.actions : [];
    if (!actions.length) {
      updateRunLog(
        `AI 网页兜底没有可执行操作${response?.error ? `：${response.error}` : ""}`,
        "warn"
      );
      return Boolean(response?.report || response?.report_zip);
    }
    let executed = 0;
    for (const action of actions) {
      const element = findFallbackElement(action.index);
      if (!element) continue;
      const label = element.innerText || element.getAttribute("aria-label") || "";
      if (isUnsafeActionLabel(label) || isUnsafeActionLabel(action.reason)) continue;
      if (action.type === "click") {
        element.click();
      } else if (action.type === "set_value") {
        writeText(element, String(action.value || ""));
      } else if (action.type === "select") {
        const value = String(action.value || "");
        const option = [...element.options || []].find((item) =>
          item.text.trim() === value || item.value === value
        );
        element.value = option ? option.value : value;
        element.dispatchEvent(new Event("input", { bubbles: true }));
        element.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        continue;
      }
      executed += 1;
      await wait(350);
    }
    if (!executed) {
      updateRunLog("AI 网页兜底操作均被安全过滤或元素失效", "warn");
      return false;
    }
    updateRunLog(`AI 网页兜底已执行 ${executed} 个操作`, "success");
    await wait(700);
    await clickPageAction();
    return true;
  }

  async function answerDragPage() {
    const question = currentQuestion() || (document.body?.innerText || "").slice(0, 1800).trim();
    const context = pageContextForModel().slice(0, 10000);
    const items = [];
    for (const doc of pageDocuments()) {
      if (!visibleDocument(doc)) continue;
    }
    const addItem = (value) => {
      const text = String(value || "").trim().replace(/\s+/g, " ");
      if (text && text.length <= 500 && !items.includes(text)) items.push(text);
    };
    for (const doc of pageDocuments()) {
      if (!visibleDocument(doc)) continue;
      for (const element of doc.querySelectorAll(
        "[draggable='true'], .drag-item, [class*='drag-item'], [class*='dragItem'], " +
        "[class*='sortable-item'], [class*='sortable-list-item'], " +
        "[class*='sort-item'], [class*='sortItem'], [class*='dnd-item']"
      )) {
        if (!visible(element) || element.closest("#freeocs-ucampus-panel, #uca-panel")) continue;
        let text = (element.innerText || element.textContent || "").trim().replace(/\s+/g, " ");
        // Some U校园 drag items expose only their number ("1.") while the
        // actual summary lives in the surrounding card/parent.
        if (/^\d+[.)、:：]?$/.test(text)) {
          const host = element.closest(
            "li, .item, [class*='item'], [class*='card'], [class*='summary'], " +
            "[class*='sentence'], [class*='option'], [class*='content']"
          );
          if (host) text = (host.innerText || host.textContent || "").trim().replace(/\s+/g, " ");
        }
        addItem(text);
      }
    }
    if (!question && items.length < 2) {
      updateRunLog("拖拽页没有可识别的题目或拖动项，无法生成答案", "warn");
      return false;
    }
    if (items.length) {
      updateRunLog(`拖动项：${items.map((item) => item.slice(0, 80)).join(" | ")}`, "info");
    }
    const prompt = [
      question || "拖动/排序题",
      context && context.slice(0, 80) !== question.slice(0, 80) ? `阅读材料：\n${context}` : "",
      items.length ? "拖动项（请根据材料判断正确顺序，只输出字母）：" : "",
      items.map((item, index) => `${String.fromCharCode(65 + index)}. ${item}`).join("\n"),
      "不要直接按 A B C D E F 的初始顺序输出；必须根据材料内容排序。",
    ].filter(Boolean).join("\n\n");
    try {
      const result = await request("/api/answer", {
        question: prompt,
        question_type: "drag",
      });
      const answer = String(result?.answer || "").trim();
      if (!answer) {
        updateRunLog("AI 未生成拖拽/排序答案", "warn");
        return false;
      }
      // The page shows lettered drag items; keep the letter order visible.
      setPanelAnswer(answer.toUpperCase(), "拖动/排序答案");
      updateRunLog(`已生成拖动/排序答案：${answer.slice(0, 300)}`, "success");
      setStatus("拖动/排序答案已显示；请手动拖动后提交。");
      return true;
    } catch (error) {
      updateRunLog(`生成拖动/排序答案失败：${error.message}`, "error");
      return false;
    }
  }

  async function answerChoiceBatch(controls, audioTranscript = "") {
    const groups = controls.groups || (controls.group ? [controls.group] : []);
    if (groups.length <= 1) return false;
    const lines = groups.map((group, index) => {
      const options = (group.options || []).map((option, optionIndex) =>
        `${String.fromCharCode(65 + optionIndex)}. ${option.text}`
      ).join("\n");
      return `${index + 1}. ${group.stem || "未命名题目"}\n选项：\n${options}`;
    });
    const question = [
      audioTranscript ? `[听力原文]\n${audioTranscript}` : "",
      ...lines,
    ].filter(Boolean).join("\n\n");
    updateRunLog(`同页 ${groups.length} 道选择题合并为一次 AI 调用`, "info");
    const result = await request("/api/answer", {
      question,
      question_type: "batch",
      context: pageContextForModel(),
    });
    const answers = String(result?.answer || "").split("\n").map((item) => item.trim()).filter(Boolean);
    if (!answers.length) throw new Error("模型未返回批量答案");
    for (const [index, group] of groups.entries()) {
      const value = answers[index];
      if (!value) continue;
      await applyAnswer(value, {
        ...controls,
        type: group.multi || controls.type === "multi-choice" ? "multi-choice" : "choice",
        options: group.options,
        group,
        radioGroup: !group.multi && Boolean(group.inputs?.[0]?.type === "radio"),
        doc: controls.doc,
      });
      await wait(250);
    }
    updateRunLog(`已批量填入 ${groups.length} 道选择题`, "success", true);
    await clickPageAction();
    return true;
  }

  async function answerDropdownBatch(controls, audioTranscript = "") {
    const dropdowns = controls.dropdowns || [];
    if (dropdowns.length <= 1) return false;
    const lines = dropdowns.map((item, index) => {
      const options = (item.options || []).map((text, optionIndex) =>
        `${String.fromCharCode(65 + optionIndex)}. ${text}`
      ).join("\n");
      return `${index + 1}. ${item.stem || "未命名题目"}\n选项：\n${options}`;
    });
    const question = [
      audioTranscript ? `[听力原文]\n${audioTranscript}` : "",
      ...lines,
    ].filter(Boolean).join("\n\n");
    updateRunLog(`同页 ${dropdowns.length} 道下拉题合并为一次 AI 调用`, "info");
    const result = await request("/api/answer", {
      question,
      question_type: "batch",
      context: pageContextForModel(),
    });
    const answers = String(result?.answer || "").split("\n").map((item) => item.trim()).filter(Boolean);
    if (!answers.length) throw new Error("模型未返回批量答案");
    for (const [index, item] of dropdowns.entries()) {
      const value = answers[index];
      if (!value) continue;
      await applyAnswer(value, {
        ...controls,
        type: "dropdown",
        dropdown: item,
        options: (item.options || []).map((text) => ({ text })),
      });
      await wait(250);
    }
    updateRunLog(`已批量填入 ${dropdowns.length} 道下拉题`, "success", true);
    await clickPageAction();
    return true;
  }

  async function processQuestion() {
    if (dismissBlockingDialog()) await wait(500);
    if (isAuthPage()) {
      await waitingForManual("请先在浏览器中登录 U校园；登录后点击开始继续");
      return false;
    }
    if (pendingNavigation) {
      pendingNavigation = false;
      setStatus("页面加载中，等待题目…");
      await wait(2000);
      await waitForQuestionReady(3, 2000);
    }
    if (await confirmSubmitDialog()) {
      await waitingForManual("检测到提交确认弹窗，等待手动提交");
      return false;
    }
    if (dismissBlockingDialog()) await wait(400);
    const initialQuestion = currentQuestion();
    const initialControls = answerControls();
    const initialVideo = videoForAutomation().video;
    const initialVideoWithQuestions = Boolean(
      initialVideo && initialQuestion &&
      ["choice", "dropdown", "blank", "blanks", "oral"].includes(initialControls.type)
    );
    const initialAnswerable =
      Boolean(initialQuestion && looksLikeQuestion(initialQuestion)) ||
      initialControls.type !== "unsupported" ||
      initialControls.type === "matching" ||
      initialVideoWithQuestions;
    if (hasSubmitAction() && !initialAnswerable && !hasQuestionInteractives() &&
      !isVoicePracticePage() && !hasVideoPlayerContainer()) {
      await waitingForManual("当前页面已到提交步骤，等待手动提交");
      return false;
    }
    if (isManualDragPage()) {
      const answered = await answerDragPage();
      await waitingForManual(
        answered
          ? "拖动/排序答案已显示；请手动拖动后提交"
          : "检测到拖动/排序题，请手动拖动完成后提交"
      );
      return false;
    }
    if (isDiscussionPage()) {
      const filled = await answerDiscussion();
      if (filled) {
        runState.completed += 1;
        await waitingForManual("讨论答案已填入，等待手动发布");
        return false;
      }
      if (submittedDiscussionKeys.has(`page|${location.href}`)) {
        updateRunLog("当前讨论页已发布，跳过重复评论", "info");
        return { type: "content" };
      }
      updateRunLog("讨论页没有可填写的编辑器，自动流程已停止", "error");
      return false;
    }
    const earlyControls = answerControls();
    if (!currentQuestion() && !looksLikeFillPage() &&
      earlyControls.type !== "dubbing" && pageActionButton()) {
      await clickPageAction();
      return { type: "content" };
    }
    const previewControls = answerControls();
    updateRunLog(`当前题型：${previewControls.type}`, "info");
    if (previewControls.type === "roleplay") {
      if (!moduleSettings.autoRecordSpeaking) {
        await waitingForManual("角色扮演需要录音/评分，已在提交前停止；请手动完成");
        return false;
      }
      try {
        await answerRoleplay(previewControls);
        updateRunLog("角色扮演已完成，停在提交前", "success", true);
        return { type: "question" };
      } catch (error) {
        await reportUnknown(currentQuestion(), `角色扮演失败：${error.message}`);
        return false;
      }
    }
    if (previewControls.type === "dubbing") {
      if (!moduleSettings.autoRecordSpeaking) {
        await waitingForManual("朗读评分题需要录音提交，已停止；请手动完成");
        return false;
      }
      try {
        const done = await answerDubbing(previewControls);
        if (!done) return false;
        updateRunLog("朗读评分已完成，停在提交前", "success");
        return { type: "question" };
      } catch (error) {
        await reportUnknown(currentQuestion(), `朗读评分失败：${error.message}`);
        return false;
      }
    }
    const detectedVideo = videoForAutomation();
    const previewQuestion = currentQuestion();
    const videoWithQuestions = Boolean(
      detectedVideo.video && previewQuestion &&
      ["choice", "dropdown", "blank", "blanks", "oral"].includes(previewControls.type)
    );
    if (detectedVideo.error && !videoWithQuestions) {
      if (unsupportedVideoSignal()) {
        await handleUnsupportedVideo(detectedVideo.error);
        return { type: "content" };
      }
      await reportUnknown(currentQuestion(), detectedVideo.error);
      return false;
    }
    if (!detectedVideo.video && unsupportedVideoSignal()) {
      await handleUnsupportedVideo("页面提示视频格式/播放不支持");
      return { type: "content" };
    }
    if (!detectedVideo.video && hasVideoPlayerContainer() &&
      previewControls.type === "unsupported" && !looksLikeQuestion(previewQuestion)) {
      await handleUnsupportedVideo("未找到可播放的视频源");
      return { type: "content" };
    }
    if (detectedVideo.video && !videoWithQuestions) {
      try {
        const completed = await playVideoToEnd(detectedVideo.video);
        if (completed) {
          updateRunLog("课程视频播放完成");
          return { type: "video" };
        }
        return false;
      } catch (error) {
        // Firefox/snap codecs or cross-origin players may report an error.
        // Continue to the next content item instead of stopping the whole run.
        await handleUnsupportedVideo(error.message);
        return { type: "content" };
      }
    }

    let videoTranscript = "";
    if (videoWithQuestions) {
      const videoKey = detectedVideo.video.currentSrc ||
        detectedVideo.video.src || location.href;
      videoTranscript = VIDEO_TRANSCRIPT_CACHE.get(videoKey) || "";
      if (videoTranscript) {
        updateRunLog("复用已转写的视频文本", "info");
      } else {
        updateRunLog("检测到视频+题目，开始提取视频音频", "info");
        setStatus("正在转写视频音频…");
        videoTranscript = await transcribeVideoAudio(detectedVideo.video);
        if (!videoTranscript) {
          updateRunLog("视频音轨不可用，改用系统录音", "info");
          setStatus("视频音轨不可用，正在录制系统声音…");
          try {
            videoTranscript = await recordPageAudioTranscript(30);
          } catch (error) {
            updateRunLog(`视频音频录制失败：${error.message}`, "error");
          }
        }
        if (videoTranscript) {
          VIDEO_TRANSCRIPT_CACHE.set(videoKey, videoTranscript);
          updateRunLog("视频音频转写完成", "info");
        } else {
          updateRunLog("视频音频转写为空", "error");
        }
      }
    }
    if (videoWithQuestions && !videoTranscript) {
      await waitingForManual(
        "视频音轨未能转写，无法依据视频内容作答；请配置 ASR 或手动完成"
      );
      return false;
    }

    let audioTranscript = videoTranscript;
    if (!videoTranscript) await primePageAudio();
    const audioList = audioSources();
    const controls = answerControls();
    const blankAudio = controls.type === "blanks" && audioList.length > 1;
    const listeningPage = /听录音|听单词|listen to|listening|选出你所听到/i.test(
      document.body?.innerText || ""
    );
    const audioLimit = (blankAudio || listeningPage) ? 12 : 3;
    if (!videoTranscript && audioList.length >= 1 && audioList.length <= audioLimit) {
      const pageKey = `${location.href}|${blankAudio ? "blanks" : "normal"}`;
      if (!PAGE_TRANSCRIPT_CACHE.has(pageKey)) {
        updateRunLog(`检测到 ${audioList.length} 个听力音频，开始转写`, "info");
        setStatus("正在转写听力音频…");
        let text = "";
        if (blankAudio || listeningPage) {
          const parts = await pageAudioTranscripts(12, 12);
          text = parts
            .map((part, index) => part ? `音频${index + 1}：${part}` : "")
            .filter(Boolean)
            .join("\n");
        } else {
          text = await pageAudioTranscript();
          if (!text) {
            setStatus("音频下载失败，正在录制系统声音…");
            try {
              text = await recordPageAudioTranscript();
            } catch (error) {
              updateRunLog(`系统录音转写失败：${error.message}`, "error");
            }
          }
        }
        if (text) PAGE_TRANSCRIPT_CACHE.set(pageKey, text);
      }
      audioTranscript = PAGE_TRANSCRIPT_CACHE.get(pageKey) || "";
      if (audioTranscript) updateRunLog("听力音频转写完成", "info");
    }

    if (listeningPage && !audioTranscript &&
      ["dropdown", "choice", "multi-choice", "blank", "blanks"].includes(controls.type)) {
      const reason = "听力页未获取到音频或转写，AI 不猜测答案";
      updateRunLog(reason, "error");
      setStatus(reason, true);
      await reportUnknown(currentQuestion(), reason);
      return false;
    }

    if (controls.type === "dropdown" && (controls.dropdowns || []).length > 1) {
      try {
        await answerDropdownBatch(controls, audioTranscript);
        return { type: "question" };
      } catch (error) {
        updateRunLog(`批量下拉作答失败，回退逐题处理：${error.message}`, "warn");
      }
    }
    if ((controls.type === "choice" || controls.type === "multi-choice") &&
      (controls.groups || []).length > 1) {
      try {
        await answerChoiceBatch(controls, audioTranscript);
        return { type: "question" };
      } catch (error) {
        updateRunLog(`批量选择题作答失败，回退逐题处理：${error.message}`, "warn");
      }
    }
    if (controls.type === "dictation") {
      await answerDictation(controls);
      return { type: "question" };
    }
    if (controls.type === "essays") {
      for (const [index, field] of controls.fields.entries()) {
        const container = field.closest(".item, [class*='question']") ||
          field.parentElement;
        let prompt = (container?.innerText || "").trim();
        if (!prompt) prompt = currentQuestion();
        prompt = prompt.slice(0, 2000);
        setStatus(`正在回答第 ${index + 1}/${controls.fields.length} 道问答题…`);
        updateRunLog(`问答题 ${index + 1}：请求模型`, "info");
        const result = await request("/api/answer", {
          question: prompt,
          question_type: "essay",
          context: pageContextForModel(),
        });
        if (!result.answer) {
          updateRunLog(`问答题 ${index + 1} 未生成答案`, "error");
          return false;
        }
        writeText(field, result.answer);
        updateRunLog(`问答题 ${index + 1} 已填入`, "success", true);
        await wait(300);
      }
      await clickPageAction();
      return { type: "question" };
    }
    const question = currentQuestion();
    if (submittedSteps.has(currentStepKey()) && !hasSubmitAction()) {
      updateRunLog("该页已提交，跳过重复提交", "info");
      return { type: "content" };
    }
    let questionForModel = audioTranscript
      ? `${question || "听力题"}\n\n[听力原文]\n${audioTranscript}`
      : question;
    if (controls.type === "matching") {
      questionForModel += "\n\n[单词]\n" +
        controls.words.map((word, index) => `${index + 1}. ${word}`).join("\n") +
        "\n[含义]\n" +
        controls.meanings.map((meaning) => meaning.text).join("\n");
    }
    if ((!question && !audioTranscript) || controls.type === "unsupported") {
      if (controls.type === "unsupported" &&
        /已全部作答/.test(controls.reason || "")) {
        updateRunLog("本页选择题已全部作答，继续下一节", "info");
        return { type: "content" };
      }
      if (controls.type === "unsupported") {
        if (isQuizSummaryPage()) {
          setStatus("检测到答题小结，等待 1 秒后继续…");
          updateRunLog("检测到答题小结，等待 1 秒后继续", "info");
          await wait(1000);
          const next = nextQuestionButton() || pageActionButton();
          if (next) {
            next.click();
            updateRunLog("已点击继续学习", "success");
          }
          return { type: "content" };
        }
        if (hasVideoPlayerContainer()) {
          const lateVideo = await waitForVisibleVideo(10000);
          if (lateVideo) {
            try {
              const finished = await playVideoToEnd(lateVideo);
              if (finished) {
                updateRunLog("视频播放完成，继续下一子模块", "info");
                return { type: "content" };
              }
            } catch (error) {
              updateRunLog(`视频无法播放：${error.message}`, "warn");
            }
          }
        }
        if (isContentOnlyPage()) {
          const contentVideo = videoForAutomation().video;
          if (contentVideo) {
            try {
              const finished = await playVideoToEnd(contentVideo);
              if (finished) updateRunLog("无题视频播放完成，继续下一子模块", "info");
            } catch (error) {
              updateRunLog(`无题视频无法播放：${error.message}`, "warn");
              await handleUnsupportedVideo(error.message);
            }
          } else {
            setStatus("无题目页面，等待 10 秒后继续…");
            updateRunLog("无题目且无视频，等待 10 秒后继续", "info");
            await wait(10000);
          }
          return { type: "content" };
        }
        const noQuestion = !question || !looksLikeQuestion(question);
        const label = noQuestion ? "无题目页面" : "未识别题型";
        showAiButton(true, question || "", controls.reason || label);
        setStatus(`${label}；可点面板“生成兼容性报告”向开发者反馈（会消耗较多 token）`);
        updateRunLog(`${label}，已显示“生成兼容性报告”按钮`, "warn");
        return { type: "unsupported" };
      }
      if (question && !looksLikeQuestion(question)) {
        updateRunLog("当前为无题目学习页，跳过答题并继续", "info");
        return { type: "content" };
      }
      const reason = !question ? "无法从页面提取当前题目文本。" : controls.reason;
      await reportUnknown(question, reason);
      return false;
    }

    setStatus("正在请求模型…");
    if (controls.type === "oral") {
      updateRunLog(`口语题：请求模型，题目长度 ${questionForModel.length}`, "info");
    }
    const contextParts = [pageContextForModel()];
    if (videoTranscript) contextParts.push(`[视频内容转写]\n${videoTranscript}`);
    const result = await request("/api/answer", {
      question: questionForModel,
      options: controls.options?.map((option, index) =>
        `${String.fromCharCode(65 + index)}. ${option.text}`
      ) || [],
      question_type: controls.type,
      blank_count: controls.type === "blanks" ? controls.fields.length : 0,
      context: contextParts.filter(Boolean).join("\n\n"),
    });
    if (controls.type === "oral") {
      if (!result.answer) {
        await reportUnknown(question, "模型未生成口语答案。");
        return false;
      }
      setStatus("正在合成口语答案…");
      if (controls.audioInput) {
        await attachGeneratedAudio(controls.audioInput, result.answer);
        setStatus("等待音频上传完成…");
        const uploaded = await waitForUploadResult(controls.doc);
        if (!uploaded) {
          updateRunLog("音频上传失败，已停止提交", "error");
          return false;
        }
        updateRunLog("音频已填入，等待手动提交", "success", true);
      } else {
        updateRunLog("未找到音频上传控件，已停止", "error");
        return false;
      }
      await waitingForManual("口语答案音频已填入，等待手动提交");
      return false;
    } else {
      try {
        await applyAnswer(result.answer, controls);
      } catch (error) {
        await reportUnknown(question, error.message);
        return false;
      }
    }
    const questionType = controls.type === "oral" ? "口语题"
      : controls.type === "blank" ? "填空题"
      : controls.type === "blanks" ? "多空填空题"
      : controls.type === "matching" ? "匹配题" : "选择题";
    updateRunLog(`${questionType}已完成`, "success", true);
    const remaining = answerControls();
    const allDone = remaining.type === "unsupported" &&
      /已全部作答/.test(remaining.reason || "");
    if (allDone || currentQuestion() === question) {
      await clickPageAction();
    }
    return { type: "question" };
  }

  function isSubmitControl(element) {
    if (!element || element.closest("#uca-panel, #freeocs-ucampus-panel")) return false;
    if (element.matches?.(".submit-btn, [class*='submit-btn']") ||
      element.closest?.(".submit-btn, [class*='submit-btn']")) {
      return true;
    }
    const label = (element.innerText || element.textContent ||
      element.getAttribute("aria-label") || element.getAttribute("title") ||
      element.value || "").replace(/\s+/g, "");
    return ["提交", "交卷", "提交答案", "保存并提交", "确定提交", "发布", "评分提交"]
      .some((word) => label === word || label === `${word}答案`);
  }

  function discussionEditorText() {
    for (const doc of pageDocuments()) {
      const editor = doc.querySelector(
        "textarea[placeholder*='评论'], [contenteditable='true'][data-placeholder*='评论'], " +
        ".discussion-cloud-recordList-title textarea"
      ) || doc.querySelector("textarea[placeholder]");
      if (editor && visible(editor)) {
        return String(editor.value || editor.textContent || "").trim().slice(0, 500);
      }
    }
    return "";
  }

  function discussionItemCount() {
    return pageDocuments().reduce((count, doc) =>
      count + doc.querySelectorAll("[class*='discussion-cloud-recordList-item']").length, 0);
  }

  function pageSignature() {
    const tabs = contentTabs().filter((tab) => tab.active)
      .map((tab) => tab.label).join("|");
    const tasks = courseTasks();
    const taskIndex = activeCourseTask(tasks);
    const task = tasks[taskIndex]
      ? `${tasks[taskIndex].label}|${tasks[taskIndex].status}`
      : "";
    const question = currentQuestion().slice(0, 300);
    return [location.href, document.title, task, tabs, question,
      answerControls().type, hasSubmitAction(), discussionEditorText(),
      discussionItemCount()].join("|");
  }

  function clearSubmitHandoff(reason = "") {
    submitHandoff = null;
    gmSet(SUBMIT_HANDOFF_KEY, null);
    if (reason) updateRunLog(reason, "warn");
  }

  function armSubmitHandoff(label) {
    if (submitHandoff) return;
    if (isDiscussionPage()) {
      submittedDiscussionKeys.add(`page|${location.href}`);
      gmSet("ucaDiscussionSubmitKeys", [...submittedDiscussionKeys].slice(-50));
    }
    submitHandoff = {
      signature: pageSignature(),
      at: Date.now(),
      url: location.href,
      label: label || "提交",
    };
    gmSet(SUBMIT_HANDOFF_KEY, submitHandoff);
    manualStop = true;
    automationRunning = false;
    updateRunLog(`检测到你点击“${label || "提交"}”，等待页面切换后自动继续`);
    setStatus("已检测到提交，等待页面切换…");
    void watchSubmitHandoff();
  }

  async function watchSubmitHandoff() {
    if (submitWatcherRunning) return;
    submitWatcherRunning = true;
    try {
      while (submitHandoff) {
        await wait(1000);
        const handoff = submitHandoff;
        if (!handoff) break;
        if (Date.now() - handoff.at > 180000) {
          clearSubmitHandoff("提交后 3 分钟没有检测到页面切换，自动继续已取消");
          break;
        }
        if (submitDialogVisible()) continue;
        if (pageSignature() === handoff.signature) continue;

        for (let retry = 0; retry < 15; retry += 1) {
          if (hasContentForAutomation() || nextLearningTarget(true) || hasSubmitAction()) break;
          await wait(1000);
        }
        if (submitDialogVisible()) continue;
        if (isQuizSummaryPage()) {
          const next = nextQuestionButton() || pageActionButton();
          if (!next) {
            clearSubmitHandoff("答题小结没有继续按钮，自动流程结束");
            setStatus("答题小结没有继续按钮，流程结束。");
            updateRunLog("答题小结没有继续按钮，流程结束", "warn");
            return;
          }
          updateRunLog("提交后点击继续学习", "success");
          const target = next.element || next;
          target.click();
          await wait(1600);
          if (isQuizSummaryPage()) {
            clearSubmitHandoff("点击继续学习后页面未切换，停止");
            setStatus("点击继续学习后页面未切换，已停止。");
            return;
          }
        }
        if (isDiscussionPage()) {
          // Publishing clears the editor but leaves us on the same discussion
          // page.  Always move forward; never restart and answer it again.
          const afterPublish = nextLearningTarget(true);
          if (!afterPublish) {
            clearSubmitHandoff("评论已发布；没有下一项，自动流程结束");
            setStatus("评论已发布，未找到下一项。");
            updateRunLog("评论已发布；没有下一项，流程结束", "success");
            return;
          }
          updateRunLog(`发布后进入下一项：${afterPublish.label}`, "info");
          afterPublish.element.click();
          await wait(1800);
          if (isDiscussionPage() || (!hasContentForAutomation() && !nextLearningTarget(true))) {
            clearSubmitHandoff("评论已发布；页面没有切换，已停止重复作答");
            setStatus("评论已发布，页面未切换，已停止。");
            updateRunLog("评论已发布；页面未切换，停止重复作答", "warn");
            return;
          }
        }
        if (!hasContentForAutomation() && !nextLearningTarget(true) && !hasSubmitAction()) {
          continue;
        }
        if (!hasContentForAutomation()) {
          const next = nextLearningTarget(true);
          if (!next) continue;
          updateRunLog(`提交后进入下一项：${next.label}`, "info");
          next.element.click();
          await wait(1500);
          if (!hasContentForAutomation()) continue;
        }

        clearSubmitHandoff();
        manualStop = false;
        courseStartAttempted = false;
        updateRunLog("提交后页面已切换，自动开始下一模块", "success");
        setStatus("正在自动开始下一个模块…");
        try {
          await request("/api/module/ucampus/start", { reason: "submit-handoff" });
        } catch (error) {
          updateRunLog(`自动开始下一模块失败：${error.message}`, "error");
          return;
        }
        // The backend queues a "start" command to this page.  Do not also
        // call runAutomation() here, or two automation loops race and click
        // adjacent Practice tabs back and forth.
        return;
      }
    } finally {
      submitWatcherRunning = false;
    }
  }

  async function runAutomation() {
    if (automationRunning) return;
    runState = loadRunState();
    automationRunning = true;
    clearPanelAnswer();
    const visited = new Set();
    const visitCounts = new Map();
    updateRunLog("开始自动学习");
    if (automationIntro) {
      updateRunLog(automationIntro);
      automationIntro = "";
    }
    try {
      while (automationRunning) {
        const stepKey = currentStepKey();
        const question = currentQuestion();
        const visits = (visitCounts.get(stepKey) || 0) + 1;
        visitCounts.set(stepKey, visits);
        if (!pendingNavigation && visited.has(stepKey) && visits > 3) {
          await reportUnknown(question, "检测到重复页面，已停止以避免重复处理。");
          break;
        }
        visited.add(stepKey);
        const outcome = await processQuestion();
        if (!outcome) {
          if (automationRunning) updateRunLog("遇到无法处理的题目，自动流程已停止", "error");
          break;
        }
        if (!automationRunning) break;
        if (pendingNavigation) {
          continue;
        }
        if (actionAdvanced) {
          actionAdvanced = false;
          pendingNavigation = true;
          continue;
        }
        const pendingControls = answerControls();
        if (currentStepKey() !== stepKey &&
          ["choice", "dropdown", "blanks"].includes(pendingControls.type)) {
          updateRunLog("当前页还有下一题，直接继续", "info");
          continue;
        }
        const allAnswered = pendingControls.type === "unsupported" &&
          /已全部作答/.test(pendingControls.reason || "");
        const next = nextLearningTarget(outcome.type === "content" || allAnswered);
        if (!next) {
          const message = outcome.type === "video"
            ? "视频已完成，未找到可识别的下一学习页，流程结束。"
            : "本页已完成，未找到下一题或目录下一项，流程结束。";
          setStatus(message);
          updateRunLog(message);
          break;
        }
        const beforeTaskIndex = activeCourseTask(courseTasks());
        setStatus(`正在进入：${next.label}`);
        const targetRect = next.element.getBoundingClientRect();
        updateRunLog(
          `跳转到：${next.label} 坐标 (${Math.round(targetRect.left)},${Math.round(targetRect.top)})`
        );
        next.element.click();
        let changed = false;
        if (next.sectionTab) {
          const tabHost = next.element.closest(
            "[class*='pc-header-tab']"
          ) || next.element;
          for (let retry = 0; retry < 24 && automationRunning; retry += 1) {
            await wait(500);
            const active = contentTabs().find((tab) => tab.active);
            if (active && active.label === next.label) {
              changed = true;
              break;
            }
            // The video page is still mounting during the first click.
            // Retry both the inner view container and its outer header.
            if (retry % 2 === 0) {
              next.element.click();
              if (tabHost !== next.element) tabHost.click();
            }
          }
          if (!changed && automationRunning) {
            await wait(1000);
            changed = true;
          }
        } else {
          for (let retry = 0; retry < 40 && automationRunning; retry += 1) {
            await wait(500);
            const taskIndex = activeCourseTask(courseTasks());
            if (currentStepKey() !== stepKey ||
              (next.task && taskIndex >= 0 && taskIndex !== beforeTaskIndex)) {
              changed = true;
              break;
            }
          }
        }
        if (changed) pendingNavigation = true;
        if (automationRunning && !changed) {
          const fallback = nextCatalogSection();
          if (fallback && fallback.element !== next.element) {
            const fallbackKey = currentStepKey();
            setStatus(`“${next.label}”无变化，改跳下一节：${fallback.label}`);
            updateRunLog(`“${next.label}”无变化，改跳下一节：${fallback.label}`, "info");
            fallback.element.click();
            for (let retry = 0; retry < 30 && automationRunning; retry += 1) {
              await wait(500);
              if (currentStepKey() !== fallbackKey) {
                changed = true;
                break;
              }
            }
            if (changed) {
              pendingNavigation = true;
              continue;
            }
          }
          const message = `点击“${next.label}”后页面没有变化，自动流程已停止。`;
          await reportUnknown(currentQuestion(), message);
          updateRunLog(message, "error");
          break;
        }
      }
      if (!automationRunning && !manualStop) updateRunLog("已手动停止自动学习");
    } catch (error) {
      setStatus(`自动答题已停止：${error.message}`, true);
      updateRunLog(`发生错误：${error.message}`, "error");
    } finally {
      automationRunning = false;
      if (!manualStop && !currentStatus.includes("失败") && !currentStatus.includes("发生错误")) {
        setStatus(`自动学习结束，本次完成 ${runState.completed} 道题。`);
      }
      if (!manualStop) {
        try {
          await request("/api/module/ucampus/finish", { reason: currentStatus });
        } catch (_) {
          // The page may be navigating; the Python module will time out the lease.
        }
      }
      manualStop = false;
    }
  }

  function attachAudio() {
    const input = pageDocuments().flatMap((doc) =>
      [...doc.querySelectorAll("input[type='file']")]
    ).find((element) => visible(element) && /audio|wav|mp3|mpeg/i.test(element.accept || ""));
    if (!input || !audioBlob) {
      setStatus("未找到可用音频上传控件；可在面板试听或下载音频。", true);
      return;
    }
    const extension = audioBlob.type.includes("wav") ? "wav" : "mp3";
    const file = new File([audioBlob], `assistant-answer.${extension}`, {
      type: audioBlob.type || "audio/mpeg",
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    setStatus("音频已放入上传控件；请检查页面预览并自行提交。");
  }

  async function handleControllerCommand(command) {
    if (command.action === "start") {
      if (automationRunning) return;
      clearSubmitHandoff();
      manualStop = false;
      runHalted = false;
      showAiButton(true);
      runState = { completed: 0, entries: [] };
      gmSet(RUN_STATE_KEY, runState);
      if (isCourseDetailPage()) await startFromCourseDetail();
      else await runAutomation();
      return;
    }
    if (command.action === "stop") {
      clearSubmitHandoff();
      automationRunning = false;
      setStatus("控制台已请求停止。");
      updateRunLog("收到控制台停止指令");
      return;
    }
    if (command.action === "read") {
      const question = currentQuestion();
      setStatus(question ? "已将当前题目同步到控制台。" : "当前页面没有可读取的题目文本。", !question);
      updateRunLog(question ? "已读取当前页面题目" : "当前页面没有可读取的题目文本", question ? "info" : "error");
      return;
    }
    if (command.action === "fill") {
      const controls = answerControls();
      if (controls.type === "unsupported") {
        await reportUnknown(currentQuestion(), controls.reason);
        return;
      }
      await applyAnswer(command.value, controls);
      updateRunLog("控制台答案已回填到当前页面", "success");
      setStatus("答案已回填；自动提交开关开启时会在完成后提交。");
      return;
    }
    if (command.action === "attach_audio") {
      const bytes = Uint8Array.from(atob(command.value), (character) => character.charCodeAt(0));
      audioBlob = new Blob([bytes], { type: command.media_type || "audio/mpeg" });
      attachAudio();
    }
  }

  let controlPanelCollapsed = false;

  function renderPanelAnswer() {
    if (window.top !== window.self) return;
    const host = document.getElementById("freeocs-ucampus-panel");
    if (!host) return;
    const wrap = host.querySelector('[data-foc="answer-wrap"]');
    const label = host.querySelector('[data-foc="answer-label"]');
    const body = host.querySelector('[data-foc="answer"]');
    if (!wrap || !label || !body) return;
    wrap.hidden = !panelAnswer;
    label.textContent = panelAnswerLabel || "排序答案";
    body.textContent = panelAnswer || "";
  }

  let lastUnsupported = null;
  let aiReportRunning = false;

  function showAiButton(show, question = "", reason = "") {
    const host = document.getElementById("freeocs-ucampus-panel");
    if (!host) return;
    const button = host.querySelector('[data-foc="ai"]');
    if (!button) return;
    if (show && (question || reason)) {
      lastUnsupported = { question, reason, url: location.href };
    }
    // Manual AI answer is available on every page, not just unsupported ones.
    button.hidden = false;
    button.disabled = aiReportRunning;
    button.textContent = aiReportRunning ? "正在生成报告…" : "生成兼容性报告";
  }

  function setPanelAnswer(text, label = "排序答案") {
    panelAnswer = String(text || "").trim();
    panelAnswerLabel = label;
    panelAnswerUrl = location.href;
    renderPanelAnswer();
    if (panelAnswer) {
      const host = document.getElementById("freeocs-ucampus-panel");
      if (host && host.classList.contains("collapsed")) {
        controlPanelCollapsed = false;
        host.classList.remove("collapsed");
        gmSet("panelCollapsed", false);
      }
    }
  }

  function clearPanelAnswer() {
    panelAnswer = "";
    panelAnswerLabel = "";
    panelAnswerUrl = "";
    renderPanelAnswer();
  }

  async function runAiDirect(button) {
    if (aiReportRunning) return;
    const info = (lastUnsupported && lastUnsupported.url === location.href)
      ? lastUnsupported
      : {
          question: currentQuestion(),
          reason: "生成兼容性报告",
          url: location.href,
        };
    aiReportRunning = true;
    showAiButton(true, info.question, info.reason);
    setPanelAnswer("AI 正在分析页面并生成兼容性报告…", "兼容性报告");
    setStatus("AI 正在生成兼容性报告…");
    let handled = false;
    try {
      handled = await runWebFallback(info.question, info.reason, {
        explicit: true,
        reportOnly: true,
      });
      if (!handled) {
        updateRunLog("兼容性报告未生成，可检查日志后重试", "warn");
      }
    } catch (error) {
      updateRunLog(`兼容性报告生成失败：${error.message}`, "error");
    } finally {
      aiReportRunning = false;
      showAiButton(true, info.question, info.reason);
    }
  }

  function createControlPanel() {
    try {
      if (window.top !== window.self) return null;
      if (document.getElementById("freeocs-ucampus-panel")) {
        return document.getElementById("freeocs-ucampus-panel");
      }
      controlPanelCollapsed = Boolean(gmGet("panelCollapsed", false));
      const host = document.createElement("div");
      host.id = "freeocs-ucampus-panel";
      host.innerHTML = `
        <div class="foc-head">
          <span class="foc-dot" data-foc="dot"></span>
          <strong>FreeOCS · U校园</strong>
          <span class="foc-page" data-foc="page"></span>
          <button type="button" class="foc-collapse" data-foc="collapse" title="折叠/展开">—</button>
        </div>
        <div class="foc-body">
          <div class="foc-status" data-foc="status">正在连接 FreeOCS…</div>
          <div class="foc-hint" data-foc="hint"></div>
          <div class="foc-run-log-wrap">
            <div class="foc-run-log-title">执行日志</div>
            <div class="foc-run-log" data-foc="run-log"></div>
          </div>
          <div class="foc-answer-wrap" data-foc="answer-wrap" hidden>
            <div class="foc-answer-label" data-foc="answer-label">排序答案</div>
            <div class="foc-answer" data-foc="answer"></div>
          </div>
          <div class="foc-actions">
            <button type="button" class="foc-start" data-foc="start">开始</button>
            <button type="button" class="foc-stop" data-foc="stop">停止</button>
            <button type="button" class="foc-ai" data-foc="ai">生成兼容性报告</button>
          </div>
          <label class="foc-auto"><input type="checkbox" data-foc="auto-submit" /> 自动提交</label>
          <div class="foc-note">关闭时只填答案；开启后会在作答完成后提交。控制范围仅限本标签页。</div>
        </div>`;
      const style = document.createElement("style");
      style.id = "freeocs-ucampus-panel-style";
      style.textContent = `
        #freeocs-ucampus-panel{all:initial;position:fixed;z-index:2147483647;right:14px;bottom:14px;width:286px;box-sizing:border-box;padding:0;border:1px solid #cfd8e6;border-radius:10px;background:#fff;color:#172033;box-shadow:0 8px 30px rgba(20,35,70,.18);font:12px/1.45 system-ui,-apple-system,"Segoe UI","Noto Sans CJK SC",sans-serif;overflow:hidden;pointer-events:auto;}
        #freeocs-ucampus-panel *{box-sizing:border-box;}
        #freeocs-ucampus-panel [hidden]{display:none !important;}
        #freeocs-ucampus-panel .foc-head{display:flex;align-items:center;gap:6px;padding:8px 10px;background:#f5f7fb;border-bottom:1px solid #e3e8f0;cursor:default;user-select:none;}
        #freeocs-ucampus-panel .foc-head strong{font-size:12px;color:#172033;white-space:nowrap;}
        #freeocs-ucampus-panel .foc-dot{width:7px;height:7px;border-radius:50%;background:#98a2b3;flex:0 0 auto;}
        #freeocs-ucampus-panel .foc-dot.on{background:#16a34a;}
        #freeocs-ucampus-panel .foc-dot.wait{background:#d97706;}
        #freeocs-ucampus-panel .foc-dot.bad{background:#dc2626;}
        #freeocs-ucampus-panel .foc-page{margin-left:auto;color:#8a94a6;font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px;}
        #freeocs-ucampus-panel .foc-collapse{border:0;background:transparent;color:#68748a;cursor:pointer;font-size:14px;line-height:1;padding:2px 4px;}
        #freeocs-ucampus-panel .foc-body{padding:9px 10px 10px;}
        #freeocs-ucampus-panel.collapsed .foc-body{display:none;}
        #freeocs-ucampus-panel .foc-status{font-size:12px;color:#172033;min-height:18px;word-break:break-word;}
        #freeocs-ucampus-panel .foc-hint{margin-top:3px;color:#68748a;font-size:11px;min-height:15px;word-break:break-word;}
        #freeocs-ucampus-panel .foc-run-log-wrap{margin-top:8px;padding-top:7px;border-top:1px solid #e3e8f0;}
        #freeocs-ucampus-panel .foc-run-log-title{font-size:10px;color:#8a94a6;margin-bottom:4px;}
        #freeocs-ucampus-panel .foc-run-log{max-height:108px;overflow:auto;display:grid;gap:3px;font-size:10px;line-height:1.45;}
        #freeocs-ucampus-panel .foc-log-row{display:grid;grid-template-columns:52px minmax(0,1fr);gap:6px;color:#46536a;}
        #freeocs-ucampus-panel .foc-log-time{color:#98a2b3;font-variant-numeric:tabular-nums;}
        #freeocs-ucampus-panel .foc-log-message{overflow-wrap:anywhere;}
        #freeocs-ucampus-panel .foc-log-row.error .foc-log-message{color:#dc2626;}
        #freeocs-ucampus-panel .foc-log-row.warn .foc-log-message{color:#b45309;}
        #freeocs-ucampus-panel .foc-log-row.success .foc-log-message{color:#15803d;}
        #freeocs-ucampus-panel .foc-log-empty{color:#98a2b3;font-size:10px;}
        #freeocs-ucampus-panel .foc-answer-wrap{margin-top:8px;padding:7px 8px;border-left:3px solid #2f6fed;border-radius:5px;background:#f4f7ff;}
        #freeocs-ucampus-panel .foc-answer-label{font-size:10px;color:#68748a;margin-bottom:3px;}
        #freeocs-ucampus-panel .foc-answer{font-size:12px;line-height:1.5;color:#172033;white-space:pre-wrap;word-break:break-word;max-height:150px;overflow:auto;user-select:text;}
        #freeocs-ucampus-panel .foc-actions{display:flex;gap:6px;margin-top:8px;}
        #freeocs-ucampus-panel button{font:inherit;border-radius:6px;cursor:pointer;padding:5px 9px;}
        #freeocs-ucampus-panel .foc-start{border:1px solid #2f6fed;background:#2f6fed;color:#fff;}
        #freeocs-ucampus-panel .foc-stop{border:1px solid #cfd8e6;background:#fff;color:#172033;}
        #freeocs-ucampus-panel .foc-ai{border:1px solid #7c3aed;background:#7c3aed;color:#fff;}
        #freeocs-ucampus-panel .foc-ai[hidden]{display:none !important;}
        #freeocs-ucampus-panel button:disabled{opacity:.45;cursor:not-allowed;}
        #freeocs-ucampus-panel .foc-auto{display:flex;align-items:center;gap:5px;margin-top:7px;color:#46536a;font-size:11px;cursor:pointer;user-select:none;}
        #freeocs-ucampus-panel .foc-auto input{accent-color:#dc2626;}
        #freeocs-ucampus-panel .foc-note{margin-top:7px;color:#8a94a6;font-size:10px;line-height:1.4;}
        @media (prefers-color-scheme: dark){
          #freeocs-ucampus-panel{background:#1a2130;color:#e7edf7;border-color:#3a4760;}
          #freeocs-ucampus-panel .foc-head{background:#202838;border-color:#2b3548;}
          #freeocs-ucampus-panel .foc-head strong,#freeocs-ucampus-panel .foc-status,#freeocs-ucampus-panel .foc-answer{color:#e7edf7;}
          #freeocs-ucampus-panel .foc-answer-wrap{background:#202838;border-left-color:#6ea0ff;}
          #freeocs-ucampus-panel .foc-stop{background:#1a2130;color:#e7edf7;border-color:#3a4760;}
        }`;
      document.documentElement.appendChild(style);
      document.documentElement.appendChild(host);
      renderRunLog();
      const start = host.querySelector('[data-foc="start"]');
      const stop = host.querySelector('[data-foc="stop"]');
      const ai = host.querySelector('[data-foc="ai"]');
      const collapse = host.querySelector('[data-foc="collapse"]');
      start.addEventListener("click", () => void panelCommand("start", start));
      stop.addEventListener("click", () => void panelCommand("stop", stop));
      ai.addEventListener("click", () => void runAiDirect(ai));
      const autoSubmit = host.querySelector('[data-foc="auto-submit"]');
      if (autoSubmit) {
        autoSubmit.checked = autoSubmitEnabled;
        autoSubmit.addEventListener("change", () => {
          autoSubmitEnabled = Boolean(autoSubmit.checked);
          gmSet("ucaAutoSubmit", autoSubmitEnabled);
          updateRunLog(autoSubmitEnabled ? "已开启自动提交" : "已关闭自动提交", "warn");
          if (autoSubmitEnabled) {
            void (async () => {
              if (hasSubmitAction()) await autoSubmitPage("开关开启");
            })();
          }
        });
      }
      collapse.addEventListener("click", () => {
        controlPanelCollapsed = !controlPanelCollapsed;
        host.classList.toggle("collapsed", controlPanelCollapsed);
        gmSet("panelCollapsed", controlPanelCollapsed);
      });
      host.classList.toggle("collapsed", controlPanelCollapsed);
      renderPanelAnswer();
      return host;
    } catch (error) {
      console.warn("[FreeOCS] control panel failed", error);
      try {
        document.documentElement.dataset.freeocsPanelError =
          String(error && (error.stack || error.message) || error);
      } catch (_) {
        // Ignore diagnostic failures.
      }
      return null;
    }
  }

  async function panelCommand(action, button) {
    button.disabled = true;
    const original = button.textContent;
    button.textContent = action === "start" ? "启动中…" : "停止中…";
    try {
      const status = await request(`/api/module/ucampus/${action}`, {});
      updateControlPanel({
        active: Boolean(status?.extra?.active ?? status?.active),
        lease: true,
        status: status?.message || (action === "start" ? "已请求启动" : "已请求停止"),
      });
      window.setTimeout(() => void pollController(), 200);
    } catch (error) {
      updateControlPanel({ active: false, lease: false, status: `操作失败：${error.message || error}` });
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function updateControlPanel(response) {
    if (window.top !== window.self) return;
    const host = document.getElementById("freeocs-ucampus-panel");
    if (!host) return;
    const active = Boolean(response && response.active);
    const lease = Boolean(response && response.lease);
    const dot = host.querySelector('[data-foc="dot"]');
    const statusEl = host.querySelector('[data-foc="status"]');
    const hintEl = host.querySelector('[data-foc="hint"]');
    const start = host.querySelector('[data-foc="start"]');
    const stop = host.querySelector('[data-foc="stop"]');
    const pageEl = host.querySelector('[data-foc="page"]');
    if (panelAnswer && panelAnswerUrl && location.href !== panelAnswerUrl) {
      clearPanelAnswer();
    }
    renderPanelAnswer();
    dot.className = `foc-dot ${active ? (lease ? "on" : "wait") : ""}`;
    if (statusEl) {
      // Local page state is fresher than the module poll snapshot (the video
      // wait can run for many minutes without a new backend status).
      statusEl.textContent = (automationRunning && currentStatus)
        ? currentStatus
        : (response?.status || (active ? "运行中" : "未开始"));
    }
    if (hintEl) {
      if (active && !lease) hintEl.textContent = "其他标签页正在受控；点“接管本页”切换。";
      else if (active && lease) hintEl.textContent = "本标签页正在受控。";
      else if (isCourseDetailPage()) hintEl.textContent = "目录页：开始后自动扫描未完成任务并进入。";
      else hintEl.textContent = "在目标标签页点击开始，避免操作错页。";
    }
    if (pageEl) pageEl.textContent = isCourseDetailPage() ? "目录页" : "学习页";
    if (start) {
      start.disabled = active && lease;
      start.textContent = active && !lease ? "接管本页" : "开始";
    }
    if (stop) stop.disabled = !active;
  }

  function isVoicePracticePage() {
    for (const doc of pageDocuments()) {
      const text = (doc.body?.innerText || "").slice(0, 5000);
      if (/dub the video|start recording|record your (?:voice|answer|conversation)|role[- ]?play|act out (?:the )?(?:conversation|dialogue)|speaking task|朗读|录音|配音/i.test(text)) {
        return true;
      }
      const controls = [...doc.querySelectorAll(
        ".button-record, .record-icon, [class*='dubbing'], [class*='record-button'], [aria-label*='record' i]"
      )].some((element) => visible(element) &&
        !element.closest("#uca-panel, #freeocs-ucampus-panel"));
      if (controls) return true;
    }
    return false;
  }

  function hasQuestionInteractives() {
    for (const doc of pageDocuments()) {
      const nodes = [...doc.querySelectorAll(
        "input, textarea, select, [contenteditable='true'], .option, " +
        "[role='radio'], [role='checkbox']"
      )];
      if (nodes.some((element) => visible(element) &&
        !element.closest("#uca-panel, #freeocs-ucampus-panel") &&
        !element.closest("#mark-edit-in, [class*='notes'], [class*='search']") &&
        !/search|搜索|笔记|note/i.test(element.getAttribute("placeholder") || ""))) {
        return true;
      }
    }
    return false;
  }

  function isQuizSummaryPage() {
    for (const doc of pageDocuments()) {
      const text = (doc.body?.innerText || "").slice(0, 8000);
      if (!/(?:答题小结|答题情况|本次答题|正确\s*[（(]\s*\d+\s*\/\s*\d+|错误\s*[（(]\s*\d+)/.test(text)) {
        continue;
      }
      const hasContinue = [...doc.querySelectorAll("button, a, [role='button']")]
        .some((element) => visible(element) &&
          /继续学习|继续答题|下一题|下一步/.test((element.innerText || "").trim()));
      if (hasContinue) return true;
    }
    return false;
  }

  function isContentOnlyPage() {
    if (isCourseDetailPage()) return false;
    const controls = answerControls();
    if (controls.type !== "unsupported") return false;
    if (hasSubmitAction() || isDiscussionPage()) return false;
    const video = videoForAutomation().video;
    const question = currentQuestion();
    if (video) {
      // Mini-lecture video pages have no question; switch to the next tab
      // (usually Practice) instead of stopping as unsupported.
      if (question && looksLikeQuestion(question)) return false;
      return Boolean(
        nextSectionTab() ||
        practiceTab() ||
        contentTabs().length > 1 ||
        pageActionButton() ||
        hasVideoPlayerContainer()
      );
    }
    if (audioSources().length) return false;
    if (question && looksLikeQuestion(question)) return false;
    return Boolean(
      nextSectionTab() ||
      contentTabs().length > 1 ||
      practiceTab() ||
      pageActionButton() ||
      hasVideoPlayerContainer()
    );
  }

  function hasContentForAutomation() {
    if (isAuthPage()) return false;
    if (isCourseDetailPage()) return courseTasks().length > 0;
    if (isDiscussionPage()) return true;
    if (currentQuestion()) return true;
    if (videoForAutomation().video) return true;
    if (hasVideoPlayerContainer()) return true;
    const controls = answerControls();
    if (controls.type !== "unsupported") return true;
    if (practiceTab()) return true;
    if (contentTabs().length > 0) return true;
    return false;
  }

  let resumeScheduled = false;

  async function pollController() {
    if (controllerPolling) return;
    controllerPolling = true;
    try {
      const controls = answerControls();
      const response = await request("/api/automation/poll", {
        client_id: CLIENT_ID,
        url: location.href,
        title: document.title,
        frame: window.top === window ? "top" : "child",
        is_course_detail: isCourseDetailPage(),
        has_content: hasContentForAutomation(),
        running: automationRunning,
        status: currentStatus,
        question: currentQuestion(),
        options: controls.options?.map((option) => option.text) || [],
        question_type: controls.type,
        completed: runState.completed,
      });
      backendConnected = true;
      applyAgentSettings(response.settings);
      updateControlPanel(response);
      if (response.command) {
        updateRunLog(`收到指令：${response.command.action}`);
        void handleControllerCommand(response.command).catch((error) => {
          updateRunLog(`指令执行失败：${error.message}`, "error");
          setStatus(`指令执行失败：${error.message}`, true);
        });
      }
      if (response.active && response.lease && !automationRunning && !manualStop &&
        !runHalted && !resumeScheduled) {
        resumeScheduled = true;
        window.setTimeout(async () => {
          resumeScheduled = false;
          if (automationRunning || runHalted) return;
          try {
            if (isCourseDetailPage()) {
              if (!courseStartAttempted) await startFromCourseDetail();
            } else if (hasContentForAutomation()) {
              await runAutomation();
            }
          } catch (error) {
            updateRunLog(`自动恢复失败：${error.message}`, "error");
          }
        }, 700);
      }
    } catch (error) {
      backendConnected = false;
    } finally {
      controllerPolling = false;
    }
  }

  function installSubmitWatcher() {
    if (window.top !== window.self) return;
    const onPress = (event) => {
      const target = event.target?.closest?.("a, button, [role='button'], .submit-btn");
      if (!target || !isSubmitControl(target)) return;
      const label = (target.innerText || target.textContent ||
        target.getAttribute("aria-label") || "提交")
        .trim().replace(/\s+/g, " ");
      armSubmitHandoff(label);
    };
    document.addEventListener("pointerdown", onPress, true);
    document.addEventListener("click", onPress, true);
  }

  function restoreSubmitHandoff() {
    if (window.top !== window.self) return;
    const saved = gmGet(SUBMIT_HANDOFF_KEY, null);
    if (saved && typeof saved.at === "number" && Date.now() - saved.at < 180000) {
      submitHandoff = saved;
      manualStop = true;
      window.setTimeout(() => void watchSubmitHandoff(), 1500);
    } else if (saved) {
      gmSet(SUBMIT_HANDOFF_KEY, null);
    }
  }

  installSubmitWatcher();
  try {
    document.documentElement.dataset.freeocsPanelInit = "1";
  } catch (_) {
    // Ignore diagnostic failures.
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      createControlPanel();
      restoreSubmitHandoff();
      void pollController();
    }, { once: true });
  } else {
    createControlPanel();
    restoreSubmitHandoff();
    void pollController();
  }
  window.setInterval(pollController, 1500);
})();
