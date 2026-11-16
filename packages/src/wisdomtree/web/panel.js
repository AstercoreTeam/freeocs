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
    if (state && state.state === "waiting") return "等待手动操作";
    if (state && state.state === "error") return "错误";
    return "未运行";
  }

  window.FreeOCS.registerPanel("wisdomtree_console", {
    mount(el, ctx) {
      this.el = el;
      this.ctx = ctx;
      this.state = ctx.getState() || {};
      this.tools = [];
      el.innerHTML = `
        <div class="wt-panel">
          <div class="flex items-center justify-between flex-wrap gap-8">
            <div class="flex items-center gap-8">
              <span class="badge" data-role="status">未运行</span>
              <span class="text-sm muted" data-role="device">未连接设备</span>
            </div>
            <div class="flex gap-8">
              <button class="btn btn-primary btn-sm" data-role="start">开始</button>
              <button class="btn btn-sm" data-role="stop">停止</button>
            </div>
          </div>

          <div class="wt-message mt-8" data-role="message">等待开始</div>
          <div class="stats-row mt-8" data-role="stats"></div>

          <dl class="kv mt-8">
            <dt>设备</dt><dd data-role="serial" class="mono">—</dd>
            <dt>分辨率</dt><dd data-role="screen">—</dd>
            <dt>题型</dt><dd data-role="type">—</dd>
            <dt>题干</dt><dd data-role="question">—</dd>
            <dt>最后点击</dt><dd data-role="clicked">—</dd>
          </dl>

          <div class="wt-safety mt-8">
            只答题，不点击交卷。检测到提交/交卷页会停止，请人工核对后操作。
          </div>

          <div class="flex items-center justify-between mt-14">
            <strong class="text-sm">AI 工具轨迹</strong>
            <button class="btn btn-ghost btn-sm" data-role="clear">清空</button>
          </div>
          <div class="wt-log" data-role="tools"></div>
        </div>`;

      this.$ = (role) => el.querySelector(`[data-role="${role}"]`);
      this.$("start").addEventListener("click", () => this.invoke("start"));
      this.$("stop").addEventListener("click", () => this.invoke("stop"));
      this.$("clear").addEventListener("click", () => {
        this.tools = [];
        this.renderTools();
      });
      ctx.onState((state) => this.update(state));
      ctx.onEvent((event) => {
        if (event.type === "tool") {
          this.tools.push(event);
          if (this.tools.length > 100) this.tools = this.tools.slice(-100);
          this.renderTools();
        }
      });
      this.update(this.state);
    },

    async invoke(action) {
      try {
        const result = await this.ctx.invoke(action, {});
        this.ctx.toast((result && result.message) || "操作完成", result && result.ok === false ? "error" : "success");
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
      this.$("device").textContent = extra.device ? `设备 ${extra.device}` : "未连接设备";
      this.$("serial").textContent = extra.device || "—";
      this.$("screen").textContent = extra.screen || "—";
      this.$("type").textContent = extra.question_type || "—";
      this.$("question").textContent = extra.question || "—";
      this.$("clicked").textContent = extra.last_clicked || "—";
      const stats = this.state.stats || {};
      this.$("stats").innerHTML = Object.entries(stats).map(([key, value]) =>
        `<span>${this.ctx.escape(key)} <b>${this.ctx.escape(value)}</b></span>`
      ).join("") || '<span class="muted">暂无统计</span>';
      this.$("start").disabled = Boolean(this.state.running);
      this.$("stop").disabled = !this.state.running;
    },

    renderTools() {
      if (!this.el) return;
      const box = this.$("tools");
      if (!this.tools.length) {
        box.innerHTML = '<div class="muted text-sm">暂无工具调用</div>';
        return;
      }
      box.innerHTML = this.tools.slice(-20).reverse().map((event) => `
        <div class="wt-log-row">
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
