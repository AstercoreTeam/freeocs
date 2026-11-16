/* Generic module detail page: skeleton + injected panels. */
(function () {
  "use strict";

  const panelRegistry = new Map();
  const panelLoads = new Map();

  window.FreeOCS = window.FreeOCS || {};
  window.FreeOCS.registerPanel = function (panelId, definition) {
    panelRegistry.set(panelId, definition);
    document.dispatchEvent(new CustomEvent("focs:panel-registered", { detail: { panelId } }));
  };

  function renderIcon(module) {
    if (module.icon) {
      const url = module.icon;
      return `<div class="module-icon" style="background:transparent;overflow:hidden;"><img src="${UI.escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;"></div>`;
    }
    return `<div class="module-icon">${UI.escapeHtml((module.name || "?").slice(0, 1))}</div>`;
  }

  function platformBadge(platform) {
    if (platform === "web") return UI.badge("网页", "primary");
    if (platform === "android") return UI.badge("手机", "primary");
    return UI.badge("通用", "");
  }

  function capabilityRow(module) {
    const missing = new Set(module.missing || []);
    const items = (module.requires || []).map((capability) =>
      `<span class="badge ${missing.has(capability) ? "danger" : "success"}">${UI.escapeHtml(capability)} ${missing.has(capability) ? "缺失" : "✓"}</span>`
    );
    return items.length ? items.join(" ") : '<span class="muted">无能力依赖</span>';
  }

  function stateView(state) {
    const badge = UI.moduleStateBadge(state);
    const progress = state.progress || {};
    const stats = state.stats || {};
    const current = Number(progress.current || 0);
    const total = Number(progress.total || 0);
    const percent = total > 0 ? Math.min(100, Math.round((current / total) * 100)) : 0;
    const statItems = Object.entries(stats).map(([key, value]) =>
      `<span>${UI.escapeHtml(key)} <b>${UI.escapeHtml(value)}</b></span>`
    ).join("");
    return {
      badge,
      html: `
        <div class="module-status-line">
          <span class="badge ${badge.cls}">${UI.escapeHtml(badge.text)}</span>
          <span class="module-message" id="module-message">${UI.escapeHtml(state.message || "等待开始")}</span>
          <span class="muted text-sm" id="module-updated">${UI.escapeHtml(state.updated_at ? UI.formatDateTime(state.updated_at) : "")}</span>
        </div>
        <div class="progress" title="${current}/${total}"><span id="module-progress" style="width:${percent}%"></span></div>
        <div class="stats-row" id="module-stats">${statItems || '<span class="muted">暂无统计</span>'}</div>`,
    };
  }

  function renderLogs(logs) {
    if (!logs.length) return UI.empty("暂无日志", "…");
    return `<div class="log-list">${logs.slice(-200).reverse().map((event) => `
      <div class="log-item ${UI.escapeHtml(event.level || "info")}">
        <span class="log-time">${UI.escapeHtml(UI.formatTime(event.ts))}</span>
        <span class="log-package">${UI.escapeHtml(event.type || "log")}</span>
        <span class="log-msg">${UI.escapeHtml(event.message || "")}</span>
      </div>`).join("")}</div>`;
  }

  async function loadAssets(panel) {
    if (panelLoads.has(panel.id)) return panelLoads.get(panel.id);
    const promise = (async () => {
      for (const href of panel.css_urls || []) {
        if (!href) continue;
        const link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = href;
        document.head.appendChild(link);
      }
      if (panel.js_url) {
        await new Promise((resolve, reject) => {
          const script = document.createElement("script");
          script.src = panel.js_url;
          script.onload = resolve;
          script.onerror = () => reject(new Error(`面板脚本加载失败：${panel.js_url}`));
          document.body.appendChild(script);
        });
      }
    })();
    panelLoads.set(panel.id, promise);
    return promise;
  }

  function panelContext(instance, panel) {
    return {
      moduleId: instance.moduleId,
      api: window.pywebview ? window.pywebview.api : null,
      getState: () => instance.state,
      invoke: (action, payload) => API.must("module_invoke", instance.moduleId, action, payload || {}),
      onState: (callback) => { instance.stateListeners.push(callback); },
      onEvent: (callback) => { instance.eventListeners.push(callback); },
      toast: UI.toast,
      escape: UI.escapeHtml,
      formatTime: UI.formatTime,
      panelId: panel.id,
    };
  }

  function mountPanel(instance, panel, container) {
    const definition = panelRegistry.get(panel.id);
    if (!definition || typeof definition.mount !== "function") {
      container.innerHTML = UI.empty("面板尚未注册（脚本可能加载失败）", "!");
      return;
    }
    if (instance.mounted && instance.mounted.panelId === panel.id) return;
    if (instance.mounted && typeof instance.mounted.definition.unmount === "function") {
      try { instance.mounted.definition.unmount(); } catch (error) { console.warn(error); }
    }
    container.innerHTML = "";
    instance.mounted = { panelId: panel.id, definition };
    try {
      definition.mount(container, panelContext(instance, panel));
    } catch (error) {
      console.error(error);
      container.innerHTML = UI.empty(`面板渲染失败：${error.message}`, "!");
    }
  }

  class ModulePage {
    constructor(container, moduleId) {
      this.container = container;
      this.moduleId = moduleId;
      this.module = null;
      this.state = {};
      this.panels = [];
      this.logs = [];
      this.stateListeners = [];
      this.eventListeners = [];
      this.timer = null;
      this.polling = false;
      this.activeTab = "state";
      this.mounted = null;
      this.onGlobalEvents = (event) => this.handleEvents(event.detail || []);
      this.onPanelRegistered = () => this.mountActivePanel();
      this.onVisibility = () => { if (!document.hidden) this.poll(); };
    }

    async init() {
      this.container.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在加载模块…</div>';
      try {
        const result = await API.must("get_module", this.moduleId);
        this.module = result.module;
        this.state = this.module.state || {};
        const panelResult = await API.must("get_module_panels", this.moduleId);
        this.panels = panelResult.panels || [];
        this.render();
        await this.loadPanelAssets();
        document.addEventListener("focs:events", this.onGlobalEvents);
        document.addEventListener("focs:panel-registered", this.onPanelRegistered);
        document.addEventListener("visibilitychange", this.onVisibility);
        this.poll();
        this.timer = window.setInterval(() => this.poll(), 1000);
      } catch (error) {
        this.container.innerHTML = `<div class="focs-page">${UI.empty(error.message || "模块加载失败", "!")}</div>`;
      }
    }

    render() {
      const module = this.module;
      const state = this.state || {};
      const view = stateView(state);
      const panels = this.panels || [];
      const tabs = [
        `<button class="tab active" data-tab="state">运行状态</button>`,
        ...panels.map((panel) => `<button class="tab" data-tab="panel-${UI.escapeHtml(panel.id)}">${UI.escapeHtml(panel.title)}</button>`),
        `<button class="tab" data-tab="logs">日志</button>`,
      ].join("");

      this.container.innerHTML = `
        <div class="focs-page module-page">
          <div class="page-header module-head">
            <div>
              <div class="module-title-row">
                ${renderIcon(module)}
                <div>
                  <h1 class="page-title">${UI.escapeHtml(module.name)}</h1>
                  <div class="page-subtitle">${UI.escapeHtml(module.description || "")}</div>
                </div>
                ${platformBadge(module.platform)}
                ${UI.badge(`v${module.version}`, "")}
                <span id="module-head-badge" class="badge ${view.badge.cls}">${UI.escapeHtml(view.badge.text)}</span>
              </div>
            </div>
            <div class="page-actions" id="module-actions"></div>
          </div>

          <div class="card module-status-card" id="module-status-card">
            ${view.html}
            <div class="form-help">能力：${capabilityRow(module)}</div>
            ${module.available ? "" : `<div class="badge danger">模块不可用：${UI.escapeHtml((module.missing || []).join(", ") || module.load_error || "未知原因")}</div>`}
            ${module.load_error ? `<div class="form-help" style="color:var(--danger)">${UI.escapeHtml(module.load_error)}</div>` : ""}
          </div>

          <div class="tabs" id="module-tabs">${tabs}</div>
          <div id="module-tab-content">
            <div class="tab-panel active" data-panel="state">
              <div class="card">
                <h3 class="card-title">运行提示</h3>
                <div class="form-help">${UI.escapeHtml((module.web && module.web.allowed_hosts || []).length ? "页面 Agent 会自动注入匹配的网页；请按操作指南完成浏览器扩展安装。" : "该模块由应用内控制；启动前请确认所需设备/服务已连接。")}</div>
                <div class="form-help mt-8">本应用不会自动提交、交卷或发布，请在提交页手动确认。</div>
              </div>
            </div>
            ${panels.map((panel) => `<div class="tab-panel" data-panel="panel-${UI.escapeHtml(panel.id)}"><div class="card" id="panel-container-${UI.escapeHtml(panel.id)}">${UI.empty("面板加载中…", "…")}</div></div>`).join("")}
            <div class="tab-panel" data-panel="logs"><div class="card"><div id="module-logs">${renderLogs(this.logs)}</div></div></div>
          </div>
        </div>`;

      this.renderActions();
      this.bindTabs();
    }

    renderActions() {
      const container = this.container.querySelector("#module-actions");
      if (!container) return;
      const module = this.module;
      const running = Boolean(this.state && this.state.running);
      const available = Boolean(module.available);
      const parts = [];
      parts.push(`<button class="btn btn-primary" id="module-start" ${running || !available ? "disabled" : ""}>开始</button>`);
      parts.push(`<button class="btn" id="module-stop" ${running ? "" : "disabled"}>停止</button>`);
      for (const action of module.actions || []) {
        const style = action.style === "danger" ? "btn-danger" : (action.style === "primary" ? "btn-primary" : "btn");
        parts.push(`<button class="btn ${style}" data-action="${UI.escapeHtml(action.id)}" ${available ? "" : "disabled"}>${UI.escapeHtml(action.label || action.id)}</button>`);
      }
      parts.push(`<button class="btn btn-ghost" id="module-back">返回应用</button>`);
      container.innerHTML = parts.join("");
      const start = container.querySelector("#module-start");
      const stop = container.querySelector("#module-stop");
      if (start) start.addEventListener("click", () => this.start());
      if (stop) stop.addEventListener("click", () => this.stop());
      const back = container.querySelector("#module-back");
      if (back) back.addEventListener("click", () => App.navigate("apps"));
      container.querySelectorAll("[data-action]").forEach((button) => {
        button.addEventListener("click", () => this.invoke(button.dataset.action));
      });
    }

    bindTabs() {
      const tabs = this.container.querySelectorAll("#module-tabs .tab");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => this.selectTab(tab.dataset.tab));
      });
    }

    selectTab(id) {
      this.activeTab = id;
      this.container.querySelectorAll("#module-tabs .tab").forEach((tab) => {
        tab.classList.toggle("active", tab.dataset.tab === id);
      });
      this.container.querySelectorAll("[data-panel]").forEach((panel) => {
        panel.classList.toggle("active", panel.dataset.panel === id);
      });
      if (id === "logs") this.renderLogs();
      this.mountActivePanel();
    }

    getActivePanel() {
      if (!this.activeTab.startsWith("panel-")) return null;
      const panelId = this.activeTab.slice("panel-".length);
      return this.panels.find((panel) => panel.id === panelId) || null;
    }

    mountActivePanel() {
      const panel = this.getActivePanel();
      if (!panel) return;
      const container = this.container.querySelector(`#panel-container-${CSS.escape(panel.id)}`);
      if (!container) return;
      mountPanel(this, panel, container);
    }

    async loadPanelAssets() {
      for (const panel of this.panels) {
        try {
          await loadAssets(panel);
        } catch (error) {
          console.warn(error);
          const container = this.container.querySelector(`#panel-container-${CSS.escape(panel.id)}`);
          if (container) container.innerHTML = UI.empty(error.message, "!");
        }
      }
      this.mountActivePanel();
    }

    async start() {
      try {
        await API.must("module_start", this.moduleId);
        UI.toast("已请求启动", "success");
        await this.poll(true);
      } catch (error) {
        UI.toast(error.message || "启动失败", "error", 5000);
      }
    }

    async stop() {
      try {
        await API.must("module_stop", this.moduleId);
        UI.toast("已请求停止", "info");
        await this.poll(true);
      } catch (error) {
        UI.toast(error.message || "停止失败", "error", 5000);
      }
    }

    async invoke(actionId) {
      const action = (this.module.actions || []).find((item) => item.id === actionId);
      if (action && action.confirm) {
        const ok = await UI.modal({ title: action.label || actionId, message: action.confirm });
        if (!ok) return;
      }
      try {
        const result = await API.must("module_invoke", this.moduleId, actionId, {});
        UI.toast((result && result.message) || "操作完成", "success");
        await this.poll(true);
      } catch (error) {
        UI.toast(error.message || "操作失败", "error", 5000);
      }
    }

    async poll(force = false) {
      if (this.polling && !force) return;
      if (document.hidden && !force) return;
      this.polling = true;
      try {
        const result = await API.must("get_module_state", this.moduleId);
        this.state = result.state || {};
        const oldRunning = Boolean(this.state && this.state.running);
        this.updateStatus();
        this.stateListeners.forEach((callback) => {
          try { callback(this.state); } catch (error) { console.warn(error); }
        });
        if (this.mounted && typeof this.mounted.definition.onState === "function") {
          try { this.mounted.definition.onState(this.state); } catch (error) { console.warn(error); }
        }
        if (oldRunning !== Boolean(this.state.running)) this.renderActions();
      } catch (error) {
        console.warn("模块状态刷新失败", error);
      } finally {
        this.polling = false;
      }
    }

    updateStatus() {
      const state = this.state || {};
      const view = stateView(state);
      const badge = this.container.querySelector("#module-head-badge");
      if (badge) {
        badge.className = `badge ${view.badge.cls}`;
        badge.textContent = view.badge.text;
      }
      const message = this.container.querySelector("#module-message");
      if (message) message.textContent = state.message || "等待开始";
      const updated = this.container.querySelector("#module-updated");
      if (updated) updated.textContent = state.updated_at ? UI.formatDateTime(state.updated_at) : "";
      const progress = this.container.querySelector("#module-progress");
      if (progress) {
        const p = state.progress || {};
        const current = Number(p.current || 0);
        const total = Number(p.total || 0);
        progress.style.width = total > 0 ? `${Math.min(100, Math.round((current / total) * 100))}%` : "0%";
      }
      const stats = this.container.querySelector("#module-stats");
      if (stats) {
        const items = Object.entries(state.stats || {}).map(([key, value]) =>
          `<span>${UI.escapeHtml(key)} <b>${UI.escapeHtml(value)}</b></span>`
        );
        stats.innerHTML = items.length ? items.join("") : '<span class="muted">暂无统计</span>';
      }
    }

    handleEvents(events) {
      const filtered = (events || []).filter((event) => event.package === this.moduleId);
      if (!filtered.length) return;
      this.logs.push(...filtered);
      if (this.logs.length > 400) this.logs = this.logs.slice(-400);
      if (this.activeTab === "logs") this.renderLogs();
      for (const event of filtered) {
        if (this.mounted && typeof this.mounted.definition.onEvent === "function") {
          try { this.mounted.definition.onEvent(event); } catch (error) { console.warn(error); }
        }
        this.eventListeners.forEach((callback) => {
          try { callback(event); } catch (error) { console.warn(error); }
        });
      }
    }

    renderLogs() {
      const container = this.container.querySelector("#module-logs");
      if (container) container.innerHTML = renderLogs(this.logs);
    }

    destroy() {
      if (this.timer) window.clearInterval(this.timer);
      this.timer = null;
      document.removeEventListener("focs:events", this.onGlobalEvents);
      document.removeEventListener("focs:panel-registered", this.onPanelRegistered);
      document.removeEventListener("visibilitychange", this.onVisibility);
      if (this.mounted && typeof this.mounted.definition.unmount === "function") {
        try { this.mounted.definition.unmount(); } catch (error) { console.warn(error); }
      }
      this.mounted = null;
      this.container.innerHTML = "";
    }
  }

  window.ModuleUI = {
    open(container, moduleId) {
      const page = new ModulePage(container, moduleId);
      page.init();
      return page;
    },
  };
})();
