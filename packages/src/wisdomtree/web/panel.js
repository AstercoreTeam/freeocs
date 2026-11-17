/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

(function () {
  "use strict";

  function statusClass(state) {
    if (state && state.running) return "success";
    if (state && state.state === "waiting") return "warning";
    if (state && state.state === "error") return "danger";
    return "";
  }

  function statusText(state) {
    if (state && state.running) return "运行中";
    if (state && state.state === "waiting") return "等待人工确认";
    if (state && state.state === "error") return "错误";
    return "未运行";
  }

  window.FreeOCS.registerPanel("wisdomtree_console", {
    mount(el, ctx) {
      this.el = el;
      this.ctx = ctx;
      this.state = ctx.getState() || {};
      el.innerHTML = `
        <div class="wt-panel">
          <div class="flex items-center justify-between flex-wrap gap-8">
            <div class="flex items-center gap-8">
              <span class="badge" data-role="status">未运行</span>
              <span class="text-sm muted" data-role="connection">未连接智慧树页面</span>
            </div>
            <div class="flex gap-8">
              <button class="btn btn-primary btn-sm" data-role="start">开始</button>
              <button class="btn btn-sm" data-role="stop">停止</button>
            </div>
          </div>

          <div class="wt-message mt-8" data-role="message">等待智慧树页面</div>
          <div class="stats-row mt-8" data-role="stats"></div>
          <dl class="kv mt-8">
            <dt>页面</dt><dd data-role="page">—</dd>
            <dt>题型</dt><dd data-role="type">—</dd>
            <dt>题干</dt><dd data-role="question">—</dd>
            <dt>最后操作</dt><dd data-role="clicked">—</dd>
          </dl>
          <div class="wt-safety mt-8" data-role="safety"></div>
        </div>`;

      this.$ = (role) => el.querySelector(`[data-role="${role}"]`);
      this.$("start").addEventListener("click", () => this.invoke("start"));
      this.$("stop").addEventListener("click", () => this.invoke("stop"));
      ctx.onState((state) => this.update(state));
      this.update(this.state);
    },

    async invoke(action) {
      try {
        const result = await this.ctx.invoke(action, {});
        this.ctx.toast(
          (result && result.message) || "操作完成",
          result && result.ok === false ? "error" : "success"
        );
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
      this.$("message").textContent = this.state.message || "等待智慧树页面";
      this.$("connection").textContent = extra.connected
        ? `已连接：${extra.page_title || extra.page_mode || "智慧树网页"}`
        : "未连接智慧树页面";
      this.$("page").textContent = extra.page_url || "—";
      this.$("type").textContent = extra.question_type || "—";
      this.$("question").textContent = extra.question || "—";
      this.$("clicked").textContent = extra.last_click
        ? `${extra.last_click.label || ""}${extra.last_click.interval_ms ? `（${extra.last_click.interval_ms} ms）` : ""}`
        : extra.last_answer ? `答案：${extra.last_answer}` : "—";
      this.$("safety").textContent = extra.auto_submit
        ? "自动提交已开启：答题后会点击提交及确认按钮。"
        : "自动提交已关闭：到达提交页后停止，等待人工核对和提交。";
      const stats = this.state.stats || {};
      this.$("stats").innerHTML = Object.entries(stats).map(([key, value]) =>
        `<span>${this.ctx.escape(key)} <b>${this.ctx.escape(value)}</b></span>`
      ).join("") || '<span class="muted">暂无统计</span>';
      this.$("start").disabled = Boolean(this.state.running);
      this.$("stop").disabled = !this.state.running;
    },

    unmount() {
      this.el = null;
      this.ctx = null;
    },
  });
})();
