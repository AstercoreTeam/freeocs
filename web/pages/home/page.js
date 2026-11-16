(function () {
  "use strict";

  function statusCard(label, value, hint, cls, action) {
    return `
      <div class="card stat-card clickable" data-go="${UI.escapeHtml(action || "")}">
        <div class="stat-label">${UI.escapeHtml(label)}</div>
        <div class="stat-value"><span class="dot ${cls}"></span> ${UI.escapeHtml(value)}</div>
        <div class="stat-hint">${UI.escapeHtml(hint || "")}</div>
      </div>`;
  }

  function eventRows(events) {
    if (!events || !events.length) return UI.empty("暂无事件", "…");
    return `<div class="log-list">${events.slice(-12).reverse().map((event) => `
      <div class="log-item ${UI.escapeHtml(event.level || "info")}">
        <span class="log-time">${UI.escapeHtml(UI.formatTime(event.ts))}</span>
        <span class="log-package">${UI.escapeHtml(event.package || "系统")}</span>
        <span class="log-msg">${UI.escapeHtml(event.message || "")}</span>
      </div>`).join("")}</div>`;
  }

  function render(root, home) {
    const llm = home.llm || {};
    const bridge = home.bridge || {};
    const modules = home.modules || {};
    const packages = home.packages || {};
    const steps = [
      { done: Boolean(llm.configured), title: "配置大模型", hint: "填写 API 地址、Key 与模型名", action: "settings" },
      { done: Boolean(bridge.connected), title: "安装并连接浏览器扩展", hint: "用于 U校园等网页应用", action: "guide" },
      { done: Number(packages.modules || 0) > 0, title: "启用至少一个应用模块", hint: "在“应用与插件”中启用", action: "apps" },
      { done: Number(modules.running || 0) > 0, title: "打开模块并开始", hint: "只填答案，不自动提交", action: "apps" },
    ];
    root.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">首页</h1>
          <p class="page-subtitle">本地优先、插件化的学习助手。所有自动化都会在提交前停下。</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-primary" data-go="apps">打开应用</button>
          <button class="btn" data-go="guide">操作指南</button>
        </div>
      </div>

      <div class="grid grid-4">
        ${statusCard("大模型", llm.configured ? "已配置" : "未配置", llm.model || llm.base_url || "点击配置", llm.configured ? "ok" : "warn", "settings")}
        ${statusCard("浏览器", bridge.connected ? "已连接" : "未连接", bridge.connected ? "扩展在线" : "安装扩展后使用网页应用", bridge.connected ? "ok" : "", "guide")}
        ${statusCard("模块", `${modules.running || 0} / ${modules.total || 0} 运行中`, "已启用模块与总数", modules.running ? "ok" : "", "apps")}
        ${statusCard("包", `${packages.enabled || 0} / ${packages.total || 0} 启用`, "插件与应用模块", "", "apps")}
      </div>

      <div class="grid grid-2 mt-14">
        <div class="card">
          <div class="card-head">
            <div>
              <h3 class="card-title">快速开始</h3>
              <div class="card-subtitle">按顺序完成，所有配置都保存在本机。</div>
            </div>
          </div>
          <div class="simple-list">
            ${steps.map((step, index) => `
              <div class="list-row">
                <div class="flex gap-8 items-center">
                  <span class="guide-num" style="${step.done ? "background:var(--success-soft);color:var(--success);" : ""}">${step.done ? "✓" : index + 1}</span>
                  <div class="list-main">
                    <div class="list-title">${UI.escapeHtml(step.title)}</div>
                    <div class="list-sub">${UI.escapeHtml(step.hint)}</div>
                  </div>
                </div>
                <button class="btn btn-sm" data-go="${step.action}">${step.done ? "查看" : "前往"}</button>
              </div>`).join("")}
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <div>
              <h3 class="card-title">最近事件</h3>
              <div class="card-subtitle">框架、插件与模块的实时状态。</div>
            </div>
            <button class="btn btn-ghost btn-sm" data-go="logs">全部日志</button>
          </div>
          <div id="home-events">${eventRows(home.events || [])}</div>
        </div>
      </div>

      <div class="card mt-14">
        <h3 class="card-title">安全边界</h3>
        <p class="form-help">
          FreeOCS 不会自动点击“提交 / 交卷 / 发布 / 评分提交”。遇到这些页面会停止并提示你手动完成。
          请仅在你被允许使用的学习内容上使用自动化辅助。
        </p>
      </div>`;

    root.querySelectorAll("[data-go]").forEach((el) => {
      el.addEventListener("click", () => App.navigate(el.dataset.go));
    });
  }

  window.definePage("home", {
    async init(params, root) {
      const target = root.querySelector("#home-root") || root;
      let lastEvents = [];
      const load = async () => {
        try {
          const result = await API.must("get_home");
          lastEvents = result.events || [];
          render(target, result);
        } catch (error) {
          target.innerHTML = `<div class="card">${UI.empty(error.message || "无法读取首页", "!")}</div>`;
        }
      };
      await load();
      const handler = (event) => {
        const events = event.detail || [];
        lastEvents = lastEvents.concat(events).slice(-12);
        const box = target.querySelector("#home-events");
        if (box) box.innerHTML = eventRows(lastEvents);
      };
      document.addEventListener("focs:events", handler);
      return { destroy: () => document.removeEventListener("focs:events", handler) };
    },
  });
})();
