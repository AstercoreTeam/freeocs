/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/* Shared UI helpers: toast, modal, formatting, badges. */
(function () {
  "use strict";

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function toast(message, type = "info", timeout = 3200) {
    const stack = document.getElementById("toast-stack");
    if (!stack) return;
    const el = document.createElement("div");
    el.className = `toast ${type}`;
    el.textContent = String(message);
    stack.appendChild(el);
    window.setTimeout(() => {
      el.style.opacity = "0";
      el.style.transition = "opacity .2s";
      window.setTimeout(() => el.remove(), 220);
    }, timeout);
  }

  function modal({ title, message, confirmText = "确定", cancelText = "取消", danger = false }) {
    return new Promise((resolve) => {
      const root = document.getElementById("modal-root");
      root.innerHTML = "";
      const mask = document.createElement("div");
      mask.className = "modal-mask";
      const box = document.createElement("div");
      box.className = "modal";
      box.innerHTML = `
        <h3>${escapeHtml(title || "确认")}</h3>
        <p>${escapeHtml(message || "")}</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" data-modal-cancel>${escapeHtml(cancelText)}</button>
          <button class="btn ${danger ? "btn-danger" : "btn-primary"}" data-modal-ok>${escapeHtml(confirmText)}</button>
        </div>`;
      mask.appendChild(box);
      root.appendChild(mask);
      const close = (value) => {
        root.innerHTML = "";
        resolve(value);
      };
      box.querySelector("[data-modal-cancel]").addEventListener("click", () => close(false));
      box.querySelector("[data-modal-ok]").addEventListener("click", () => close(true));
      mask.addEventListener("click", (event) => {
        if (event.target === mask) close(false);
      });
      window.setTimeout(() => box.querySelector("[data-modal-ok]").focus(), 20);
    });
  }

  function formatTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleTimeString("zh-CN", { hour12: false });
  }

  function formatDateTime(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString("zh-CN", { hour12: false });
  }

  function formatBytes(value) {
    const size = Number(value || 0);
    if (!Number.isFinite(size) || size <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let index = 0;
    let current = size;
    while (current >= 1024 && index < units.length - 1) {
      current /= 1024;
      index += 1;
    }
    return `${current.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
  }

  function moduleStateBadge(state) {
    const value = (state && state.state) || "idle";
    if (state && state.running) return { text: "运行中", cls: "success" };
    if (value === "error") return { text: "错误", cls: "danger" };
    if (value === "waiting") return { text: "等待中", cls: "warning" };
    if (value === "stopping") return { text: "停止中", cls: "warning" };
    return { text: "未运行", cls: "" };
  }

  function packageStatusBadge(pkg) {
    if (!pkg.enabled) return { text: "已禁用", cls: "" };
    if (pkg.status === "ready") return { text: "可用", cls: "success" };
    if (pkg.status === "unavailable") return { text: "缺少能力", cls: "danger" };
    if (pkg.status === "error") return { text: "加载失败", cls: "danger" };
    if (pkg.status === "disabled") return { text: "已禁用", cls: "" };
    return { text: pkg.status || "未知", cls: "" };
  }

  function badge(text, cls = "") {
    return `<span class="badge ${cls}">${escapeHtml(text)}</span>`;
  }

  function empty(text, icon = "○") {
    return `<div class="empty"><div class="empty-icon">${escapeHtml(icon)}</div><div>${escapeHtml(text)}</div></div>`;
  }

  function copyText(text) {
    const value = String(text == null ? "" : text);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value).then(() => true).catch(() => fallbackCopy(value));
    }
    return Promise.resolve(fallbackCopy(value));
  }

  function fallbackCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch (error) {
      ok = false;
    }
    area.remove();
    return ok;
  }

  window.UI = {
    escapeHtml,
    escape: escapeHtml,
    toast,
    modal,
    formatTime,
    formatDateTime,
    formatBytes,
    moduleStateBadge,
    packageStatusBadge,
    badge,
    empty,
    copyText,
  };
})();
