/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* Main shell: navigation, page loading, header status and event polling. */
(function () {
  "use strict";

  const state = {
    bootstrap: null,
    currentPage: null,
    currentId: "",
    params: {},
    eventSeq: 0,
    eventTimer: null,
    statusTimer: null,
    loadToken: 0,
    pageDefs: {},
    loadedScripts: new Set(),
    loadedCss: new Set(),
  };

  const NAV_ICONS = {
    home: "⌂",
    apps: "▦",
    models: "↓",
    guide: "?",
    settings: "⚙",
    logs: "≣",
    "ai-calls": "◈",
  };

  function t(key, fallback) {
    return fallback || key;
  }

  function applyTheme(theme) {
    const value = ["light", "dark", "system"].includes(theme) ? theme : "light";
    document.documentElement.dataset.theme = value;
    const button = document.getElementById("btn-theme");
    if (button) {
      button.textContent = value === "dark" ? "浅色" : (value === "system" ? "跟随系统" : "深色");
    }
  }

  function renderNav(items) {
    const nav = document.getElementById("focs-nav");
    nav.innerHTML = "";
    (items || []).forEach((item) => {
      const el = document.createElement("div");
      el.className = "nav-item";
      el.dataset.page = item.id;
      el.innerHTML = `<span class="nav-icon">${NAV_ICONS[item.id] || "•"}</span><span class="nav-text">${UI.escapeHtml(item.title)}</span>`;
      el.addEventListener("click", () => navigate(item.id));
      nav.appendChild(el);
    });
  }

  function setActiveNav(id) {
    document.querySelectorAll("#focs-nav .nav-item").forEach((item) => {
      item.classList.toggle("active", item.dataset.page === id);
    });
  }

  function renderStatus() {
    const data = state.bootstrap || {};
    const settings = data.settings || {};
    const bridge = data.bridge || {};
    const llm = settings.llm || {};
    const container = document.getElementById("global-status");
    if (!container) return;
    const chips = [];
    chips.push({
      cls: llm.configured ? "ok" : "warn",
      text: llm.configured ? `大模型 ${llm.model || ""}` : "大模型未配置",
      action: "home",
      title: llm.base_url || "点击配置大模型",
    });
    chips.push({
      cls: bridge.connected ? "ok" : "",
      text: bridge.connected ? "浏览器已连接" : "浏览器未连接",
      action: "guide",
      title: bridge.server || "点击查看安装指南",
    });
    container.innerHTML = chips.map((chip) => `
      <span class="status-chip ${chip.cls}" data-go="${chip.action}" title="${UI.escapeHtml(chip.title)}">
        <span class="dot"></span>${UI.escapeHtml(chip.text)}
      </span>`).join("");
    container.querySelectorAll("[data-go]").forEach((el) => {
      el.addEventListener("click", () => navigate(el.dataset.go));
    });
  }

  async function refreshBridgeStatus() {
    try {
      const result = await API.call("get_bridge_status");
      if (result && result.ok && state.bootstrap) {
        state.bootstrap.bridge = result.bridge;
        renderStatus();
      }
    } catch (error) {
      console.warn("刷新浏览器状态失败", error);
    }
  }

  function bindHeader() {
    document.getElementById("btn-settings").addEventListener("click", () => navigate("settings"));
    document.getElementById("btn-theme").addEventListener("click", async () => {
      const current = document.documentElement.dataset.theme;
      const next = current === "dark" ? "light" : "dark";
      applyTheme(next);
      try {
        await API.must("save_settings", "ui", { theme: next });
        if (state.bootstrap) state.bootstrap.ui.theme = next;
      } catch (error) {
        UI.toast(error.message || "主题保存失败", "error");
      }
    });
    document.getElementById("btn-about").addEventListener("click", async () => {
      const info = (state.bootstrap && state.bootstrap.app) || {};
      await UI.modal({
        title: "关于 FreeOCS",
        message: `版本：${info.version || "?"}\n平台：${info.platform || "?"}\nPython：${info.python || "?"}\n数据目录：${info.data_dir || "?"}\n设置目录：${info.config_dir || "?"}\n\nCopyright 2026 AstercoreTeam\n作者：\nqincnd <qincnd@qq.com>\nXueZicheng <xuezicheng842@outlook.com>\n\n许可：GNU Affero General Public License v3.0 only\nhttps://spdx.org/licenses/AGPL-3.0-only.html\n\n本地优先 · 插件化`,
        confirmText: "知道了",
        cancelText: "关闭",
      });
    });
  }

  function loadScript(src) {
    if (state.loadedScripts.has(src)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = src;
      script.charset = "utf-8";
      script.onload = () => {
        state.loadedScripts.add(src);
        resolve();
      };
      script.onerror = () => reject(new Error(`脚本加载失败：${src}`));
      document.body.appendChild(script);
    });
  }

  function loadCss(href) {
    if (state.loadedCss.has(href)) return;
    state.loadedCss.add(href);
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
  }

  async function loadPage(id, params) {
    const token = ++state.loadToken;
    if (state.currentPage && typeof state.currentPage.destroy === "function") {
      try { state.currentPage.destroy(); } catch (error) { console.warn(error); }
    }
    state.currentPage = null;
    state.currentId = id;
    state.params = params || {};
    setActiveNav(id === "module" ? "apps" : id);

    const content = document.getElementById("page-content");
    content.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在加载…</div>';
    try {
      const assetVersion = "20261117-5";
      await loadScript(`pages/${id}/page.js?v=${assetVersion}`);
      loadCss(`pages/${id}/page.css?v=${assetVersion}`);
      const response = await fetch(`pages/${id}/index.html`, { cache: "no-store" });
      if (!response.ok) throw new Error(`页面不存在：pages/${id}/index.html`);
      const html = await response.text();
      if (token !== state.loadToken) return;
      content.innerHTML = html;
      const definition = state.pageDefs[id];
      if (!definition) throw new Error(`页面未注册：${id}`);
      if (typeof definition.init === "function") {
        const instance = await definition.init(state.params, content);
        if (token !== state.loadToken) {
          if (instance && typeof instance.destroy === "function") instance.destroy();
          return;
        }
        state.currentPage = instance || definition;
      } else {
        state.currentPage = definition;
      }
    } catch (error) {
      console.error(error);
      content.innerHTML = `<div class="focs-page"><div class="card">${UI.empty(error.message || "页面加载失败", "!")}</div></div>`;
    }
  }

  function parseHash() {
    const raw = (location.hash || "").replace(/^#\/?/, "");
    if (!raw) return null;
    const parts = raw.split("/").filter(Boolean);
    if (!parts.length) return null;
    if (parts[0] === "module" && parts[1]) {
      return { id: "module", params: { id: decodeURIComponent(parts[1]) } };
    }
    if (parts[0] === "settings" && parts[1]) {
      return { id: "settings", params: { section: decodeURIComponent(parts[1]) } };
    }
    const known = ["home", "apps", "models", "guide", "settings", "logs"];
    if (known.includes(parts[0])) return { id: parts[0], params: {} };
    return null;
  }

  function navigate(id, params = {}) {
    const nextParams = params || {};
    let hash = `#/${id}`;
    if (id === "module" && nextParams.id) {
      hash = `#/module/${encodeURIComponent(nextParams.id)}`;
    } else if (id === "settings" && nextParams.section) {
      hash = `#/settings/${encodeURIComponent(nextParams.section)}`;
    }
    if (location.hash === hash) {
      loadPage(id, nextParams);
      return;
    }
    location.hash = hash;
    // hashchange will trigger loadPage
  }

  function showLicenseGate() {
    const gate = document.getElementById("license-gate");
    const check = document.getElementById("license-check");
    const accept = document.getElementById("license-accept");
    const decline = document.getElementById("license-decline");
    if (!gate || !check || !accept || !decline) return;
    gate.hidden = false;
    // Never inherit browser form restoration from a previous launch.
    check.checked = false;
    accept.disabled = true;
    check.addEventListener("change", () => {
      accept.disabled = !check.checked;
    });
    accept.addEventListener("click", async () => {
      if (!check.checked) return;
      try {
        await API.must("accept_license");
        gate.hidden = true;
        await boot();
      } catch (error) {
        UI.toast(error.message || "无法保存协议同意状态", "error");
      }
    });
    decline.addEventListener("click", async () => {
      try {
        await API.call("decline_license");
      } catch (_) {
        // Closing the window below is the final fallback.
      }
      try { window.close(); } catch (_) { /* ignore */ }
    });
  }

  async function boot() {
    try {
      const result = await API.call("get_bootstrap");
      if (!result || result.ok !== true) {
        throw new Error((result && result.error) || "无法读取启动信息");
      }
      state.bootstrap = result;
      state.eventSeq = result.last_seq || 0;
      if (result.license && result.license.required) {
        showLicenseGate();
        return;
      }
      applyTheme((result.ui && result.ui.theme) || "light");
      renderNav(result.nav || []);
      bindHeader();
      renderStatus();

      const route = parseHash();
      const startPage = (result.ui && result.ui.start_page) || "home";
      if (route) {
        await loadPage(route.id, route.params);
      } else {
        await loadPage(["home", "apps", "models", "guide"].includes(startPage) ? startPage : "home", {});
      }
      startEventPolling();
      state.statusTimer = window.setInterval(refreshBridgeStatus, 8000);
    } catch (error) {
      console.error(error);
      document.getElementById("page-content").innerHTML = `
        <div class="focs-page"><div class="card">
          <h1 class="page-title">启动失败</h1>
          <p class="page-subtitle">${UI.escapeHtml(error.message || String(error))}</p>
          <p class="form-help">请查看终端日志，或重新启动应用。</p>
        </div></div>`;
    }
  }

  function startEventPolling() {
    if (state.eventTimer) window.clearInterval(state.eventTimer);
    state.eventTimer = window.setInterval(async () => {
      if (document.hidden) return;
      try {
        const result = await API.call("get_events", state.eventSeq, 200);
        if (!result || result.ok !== true) return;
        state.eventSeq = result.last_seq || state.eventSeq;
        const events = result.events || [];
        if (events.length) {
          document.dispatchEvent(new CustomEvent("focs:events", { detail: events }));
        }
      } catch (error) {
        console.warn("事件轮询失败", error);
      }
    }, 900);
  }

  window.addEventListener("hashchange", () => {
    const route = parseHash();
    if (route) loadPage(route.id, route.params);
  });

  window.definePage = function (id, definition) {
    state.pageDefs[id] = definition;
  };

  window.App = {
    navigate,
    toast: UI.toast,
    get params() { return state.params; },
    get bootstrap() { return state.bootstrap; },
    get currentId() { return state.currentId; },
    reloadBootstrap: async () => {
      const result = await API.call("get_bootstrap");
      if (result && result.ok) {
        state.bootstrap = result;
        renderStatus();
      }
      return result;
    },
    refreshStatus: renderStatus,
    formatTime: UI.formatTime,
    escape: UI.escapeHtml,
    openPath: (path) => API.must("open_path", path),
    openExternal: (url) => API.must("open_external", url),
  };

  let bootStarted = false;
  function startApp() {
    if (bootStarted) return;
    if (!window.pywebview || !window.pywebview.api) return;
    bootStarted = true;
    boot();
  }
  if (window.pywebview && window.pywebview.api) {
    startApp();
  } else {
    window.addEventListener("pywebviewready", startApp, { once: true });
    const poll = window.setInterval(() => {
      if (window.pywebview && window.pywebview.api) {
        window.clearInterval(poll);
        startApp();
      }
    }, 100);
  }
})();
