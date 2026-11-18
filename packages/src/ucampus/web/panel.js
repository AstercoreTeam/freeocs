/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

(function () {
  "use strict";

  function statusClass(state) {
    const value = state && state.state;
    if (state && state.running) return "success";
    if (value === "waiting") return "warning";
    if (value === "error") return "danger";
    return "";
  }

  function statusText(state) {
    if (state && state.running) return "运行中";
    if (state && state.state === "waiting") return "等待手动操作";
    if (state && state.state === "error") return "错误";
    return "未运行";
  }

  window.FreeOCS.registerPanel("ucampus_console", {
    mount(el, ctx) {
      this.el = el;
      this.ctx = ctx;
      this.logs = [];
      this.state = ctx.getState() || {};
      el.innerHTML = `
        <div class="uca-panel">
          <div class="flex items-center justify-between flex-wrap gap-8">
            <div class="flex items-center gap-8">
              <span class="badge" data-role="status">未运行</span>
              <span class="text-sm muted" data-role="page-title">尚未连接页面</span>
            </div>
            <div class="flex gap-8">
              <button class="btn btn-primary btn-sm" data-role="start">开始</button>
              <button class="btn btn-sm" data-role="stop">停止</button>
              <button class="btn btn-sm" data-role="read">读取当前页</button>
            </div>
          </div>

          <div class="uca-message mt-8" data-role="message">等待开始</div>
          <div class="progress mt-8"><span data-role="progress" style="width:0%"></span></div>

          <div class="stats-row mt-8" data-role="stats"></div>

          <dl class="kv mt-8">
            <dt>页面</dt><dd data-role="url" class="mono">—</dd>
            <dt>题型</dt><dd data-role="type">—</dd>
            <dt>当前答案</dt><dd data-role="answer">—</dd>
          </dl>

          <div class="uca-safety mt-8">
            默认只填答案；可在面板开启自动提交。
          </div>

          <div class="flex items-center justify-between mt-14">
            <strong class="text-sm">最近日志</strong>
            <button class="btn btn-ghost btn-sm" data-role="clear">清空</button>
          </div>
          <div class="uca-log" data-role="logs"></div>
        </div>`;

      this.$ = (role) => el.querySelector(`[data-role="${role}"]`);
      this.$("start").addEventListener("click", () => this.invoke("start"));
      this.$("stop").addEventListener("click", () => this.invoke("stop"));
      this.$("read").addEventListener("click", () => this.invoke("read"));
      this.$("clear").addEventListener("click", () => {
        this.logs = [];
        this.renderLogs();
      });

      ctx.onState((state) => this.update(state));
      ctx.onEvent((event) => {
        this.logs.push(event);
        if (this.logs.length > 100) this.logs = this.logs.slice(-100);
        this.renderLogs();
      });
      this.update(this.state);
    },

    async invoke(action) {
      try {
        const result = await this.ctx.invoke(action, {});
        this.ctx.toast((result && result.message) || "操作完成", result && result.ok === false ? "error" : "success");
        if (action === "start" || action === "stop") {
          // The module state will be refreshed by the generic skeleton.
          this.update(this.state);
        }
      } catch (error) {
        this.ctx.toast(error.message || "操作失败", "error");
      }
    },

    update(state) {
      if (!this.el) return;
      this.state = state || {};
      const extra = this.state.extra || {};
      const badge = this.$("status");
      badge.className = `badge ${statusClass(this.state)}`;
      badge.textContent = statusText(this.state);
      this.$("message").textContent = this.state.message || "等待开始";
      this.$("page-title").textContent = extra.page_title || "尚未连接页面";
      this.$("url").textContent = extra.page_url || "—";
      this.$("type").textContent = extra.question_type || "—";
      this.$("answer").textContent = extra.last_answer || "—";
      const progress = this.$("progress");
      const total = Number((this.state.progress || {}).total || 0);
      const current = Number((this.state.progress || {}).current || 0);
      progress.style.width = total > 0 ? `${Math.min(100, Math.round(current / total * 100))}%` : "0%";
      const stats = this.state.stats || {};
      this.$("stats").innerHTML = Object.entries(stats).map(([key, value]) =>
        `<span>${this.ctx.escape(key)} <b>${this.ctx.escape(value)}</b></span>`
      ).join("") || '<span class="muted">暂无统计</span>';
      this.$("start").disabled = Boolean(this.state.running);
      this.$("stop").disabled = !this.state.running;
      this.$("read").disabled = !extra.active;
    },

    renderLogs() {
      if (!this.el) return;
      const box = this.$("logs");
      if (!this.logs.length) {
        box.innerHTML = '<div class="muted text-sm">暂无日志</div>';
        return;
      }
      box.innerHTML = this.logs.slice(-20).reverse().map((event) => `
        <div class="uca-log-row ${this.ctx.escape(event.level || "info")}">
          <span class="muted">${this.ctx.escape(this.ctx.formatTime(event.ts))}</span>
          <span>${this.ctx.escape(event.message || "")}</span>
        </div>`).join("");
    },

    unmount() {
      this.el = null;
      this.ctx = null;
    },
  });
})();
