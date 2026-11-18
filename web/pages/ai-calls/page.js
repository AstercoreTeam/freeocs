/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* Local AI call audit trail: prompt, response, usage and latency. */
(function () {
  "use strict";

  function renderCall(call, selected) {
    const usage = (call.response && call.response.usage) || {};
    const ok = call.ok !== false;
    return `<button class="ai-call-row ${selected ? "is-selected" : ""}" data-seq="${UI.escapeHtml(String(call.ts || ""))}">
      <span class="ai-call-time">${UI.escapeHtml(UI.formatDateTime(call.ts))}</span>
      <span class="badge ${ok ? "success" : "danger"}">${ok ? "OK" : "ERR"}</span>
      <span class="ai-call-source">${UI.escapeHtml(call.source || "unknown")}</span>
      <span class="ai-call-model">${UI.escapeHtml(call.model || "—")}</span>
      <span class="ai-call-num">${Number(usage.total_tokens || 0)} tok</span>
      <span class="ai-call-num">${Number(call.latency_ms || 0)} ms</span>
    </button>`;
  }

  function safeJson(value) {
    try { return JSON.stringify(value, null, 2); }
    catch (_) { return String(value); }
  }

  function detailHtml(call) {
    const req = call.request || {};
    const res = call.response || {};
    return `<div class="ai-call-detail">
      <div class="ai-call-meta">
        <span>${UI.escapeHtml(call.ts || "")}</span>
        <span>${UI.escapeHtml(call.source || "")}</span>
        <span>${UI.escapeHtml(call.model || "")}</span>
        <span>${Number(call.latency_ms || 0)} ms</span>
      </div>
      <h3>请求消息</h3>
      <pre>${UI.escapeHtml(safeJson(req.messages))}</pre>
      <h3>请求参数</h3>
      <pre>${UI.escapeHtml(safeJson(req.options))}</pre>
      <h3>响应</h3>
      <pre>${UI.escapeHtml(safeJson(res))}</pre>
      ${call.error ? `<h3>错误</h3><pre class="ai-call-error">${UI.escapeHtml(String(call.error))}</pre>` : ""}
    </div>`;
  }

  window.definePage("ai-calls", {
    async init(params, root) {
      const target = root.querySelector("#ai-calls-root") || root;
      target.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在读取 AI 调用记录…</div>';
      let calls = [];
      let selected = "";
      let timer = null;
      let polling = false;
      let lastSignature = "";

      target.innerHTML = `
        <div class="page-header">
          <div>
            <h1 class="page-title">AI 调用</h1>
            <p class="page-subtitle">每次大模型调用的请求、响应、Token 用量与耗时，仅保存在本机。</p>
          </div>
          <div class="page-actions">
            <button class="btn btn-sm" id="ai-calls-refresh">刷新</button>
            <button class="btn btn-sm" id="ai-calls-open">打开记录目录</button>
          </div>
        </div>
        <div class="ai-call-stats" id="ai-call-stats"></div>
        <div class="ai-call-layout">
          <div class="card ai-call-list-card">
            <div class="ai-call-list-head">
              <strong>最近调用</strong>
              <span class="form-help" id="ai-call-count"></span>
            </div>
            <div id="ai-call-list"></div>
          </div>
          <div class="card ai-call-detail-card" id="ai-call-detail">
            ${UI.empty("选择一条记录查看完整请求和响应", "◈")}
          </div>
        </div>`;

      const statsEl = target.querySelector("#ai-call-stats");
      const listEl = target.querySelector("#ai-call-list");
      const detailEl = target.querySelector("#ai-call-detail");
      const countEl = target.querySelector("#ai-call-count");

      async function load() {
        if (polling) return;
        polling = true;
        try {
          const result = await API.must("get_ai_calls", 500);
          calls = result.calls || [];
          const signature = calls.map((call) => `${call.ts}|${call.ok}|${call.model}`).join("\n");
          if (signature === lastSignature) {
            return;
          }
          lastSignature = signature;
          const listScroll = listEl.scrollTop;
          const detailScroll = detailEl.scrollTop;
          const windowScroll = window.scrollY;
          const stats = result.stats || {};
          statsEl.innerHTML = `
            <div class="ai-call-stat"><span>记录数</span><strong>${Number(stats.calls || 0)}</strong></div>
            <div class="ai-call-stat"><span>错误</span><strong>${Number(stats.errors || 0)}</strong></div>
            <div class="ai-call-stat"><span>平均耗时</span><strong>${Number(stats.avg_latency_ms || 0)} ms</strong></div>
            <div class="ai-call-stat ai-call-folder"><span>目录</span><code>${UI.escapeHtml(stats.folder || "")}</code></div>`;
          countEl.textContent = `${calls.length} 条`;
          listEl.innerHTML = calls.length
            ? calls.map((call) => renderCall(call, call.ts === selected)).join("")
            : UI.empty("还没有 AI 调用记录", "◈");
          listEl.querySelectorAll(".ai-call-row").forEach((row) => {
            row.addEventListener("click", () => {
              selected = row.dataset.seq || "";
              const call = calls.find((item) => item.ts === selected);
              if (!call) return;
              detailEl.innerHTML = detailHtml(call);
              listEl.querySelectorAll(".ai-call-row").forEach((item) =>
                item.classList.toggle("is-selected", item === row));
            });
          });
          if (selected) {
            const call = calls.find((item) => item.ts === selected);
            if (call) detailEl.innerHTML = detailHtml(call);
          }
          listEl.scrollTop = listScroll;
          detailEl.scrollTop = detailScroll;
          window.scrollTo({ top: windowScroll });
        } catch (error) {
          listEl.innerHTML = UI.empty(error.message || "读取 AI 调用记录失败", "!");
        } finally {
          polling = false;
        }
      }

      target.querySelector("#ai-calls-refresh").addEventListener("click", () => void load());
      target.querySelector("#ai-calls-open").addEventListener("click", async () => {
        try { await API.must("open_ai_calls"); }
        catch (error) { UI.toast(error.message || "无法打开目录", "error"); }
      });
      await load();
      timer = window.setInterval(() => { if (!document.hidden) void load(); }, 2500);
      return { destroy: () => window.clearInterval(timer) };
    },
  });
})();
