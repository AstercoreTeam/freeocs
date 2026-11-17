/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

(function () {
  "use strict";

  function formatBytes(value) {
    const bytes = Number(value || 0);
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function renderModels(root, models) {
    root.innerHTML = (models || []).map((model) => `
      <article class="card model-card">
        <div class="card-head">
          <div>
            <h2 class="card-title">${UI.escapeHtml(model.name)}</h2>
            <p class="card-subtitle">${UI.escapeHtml(model.description)}</p>
          </div>
        </div>
        <div class="model-files">
          ${model.kind === "ollama"
            ? `<div>Ollama 模型：<code>${UI.escapeHtml(model.ollama_tag)}</code></div>
               <div>由 Ollama 管理模型文件；可通过 OLLAMA_MODELS 配置保存位置。</div>`
            : (model.files || []).map((file) => `<div><code>${UI.escapeHtml(file)}</code></div>`).join("")}
        </div>
        <div class="model-repositories">
          ${(model.repositories || []).map((repo) => {
            const path = repo.split("/").map(encodeURIComponent).join("/");
            return `<a href="https://huggingface.co/${path}" target="_blank" rel="noopener noreferrer">${UI.escapeHtml(repo)}</a>`;
          }).join(" · ")}
        </div>
        <button class="btn btn-primary model-download" data-model-id="${UI.escapeHtml(model.id)}" data-kind="${UI.escapeHtml(model.kind || "files")}">${model.kind === "ollama" ? "拉取到 Ollama" : "下载"}</button>
      </article>`).join("");
  }

  function renderDownloadStatus(container, download, root) {
    if (!download || download.state === "idle") {
      container.hidden = true;
      container.innerHTML = "";
      root.querySelectorAll(".model-download").forEach((button) => {
        button.disabled = false;
        button.textContent = button.dataset.kind === "ollama" ? "拉取到 Ollama" : "下载";
      });
      return;
    }
    container.hidden = false;
    const busy = ["downloading", "cancelling"].includes(download.state);
    root.querySelectorAll(".model-download").forEach((button) => {
      const active = busy && button.dataset.modelId === download.model_id;
      button.disabled = busy;
      button.textContent = active
        ? (download.kind === "ollama" ? "拉取中…" : "下载中…")
        : (button.dataset.kind === "ollama" ? "拉取到 Ollama" : "下载");
    });
    const total = Number(download.current_total || 0);
    const current = Number(download.current_bytes || 0);
    const count = Number(download.file_count || 0);
    const completed = Number(download.completed_files || 0);
    const calculated = count
      ? Math.round((completed + (total ? Math.min(1, current / total) : 0)) * 100 / count)
      : Number(download.progress || 0);
    const progress = download.state === "completed" ? 100 : Math.min(100, calculated);
    let stateText = {
      downloading: "正在下载",
      cancelling: "正在取消…",
      completed: "下载完成",
      cancelled: "已取消",
      failed: "下载失败",
    }[download.state] || download.state;
    if (download.kind === "ollama") {
      stateText = {
        downloading: "正在拉取",
        cancelling: "正在取消…",
        completed: "拉取完成",
        cancelled: "已取消",
        failed: "拉取失败",
      }[download.state] || download.state;
    }
    const detail = busy
      ? `${completed + 1}/${count} · ${download.current_file || ""} · ${formatBytes(current)}${total ? ` / ${formatBytes(total)}` : ""}`
      : (download.error || download.target_dir || "");
    container.innerHTML = `
      <div class="model-status-head">
        <div>
          <strong>${UI.escapeHtml(download.name || "模型下载")}：${UI.escapeHtml(stateText)}</strong>
          <div class="form-help">${UI.escapeHtml(detail)}</div>
        </div>
        ${busy ? '<button class="btn btn-sm btn-danger" id="model-download-cancel">取消下载</button>' : ""}
      </div>
      <div class="model-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}">
        <span style="width:${progress}%"></span>
      </div>
      <div class="form-help">${progress}% · ${download.kind === "ollama" ? "模型位置：" : "保存位置："}${UI.escapeHtml(download.target_dir || "")}</div>`;
  }

  window.definePage("models", {
    async init(params, root) {
      const target = root.querySelector("#models-root") || root;
      target.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在读取模型列表…</div>';
      let timer = null;
      let polling = false;

      try {
        const result = await API.must("get_model_download_catalog");
        target.innerHTML = `
          <div class="page-header">
            <div>
              <h1 class="page-title">模型下载</h1>
              <p class="page-subtitle">选择模型和保存目录；下载由本地 Python 后端执行，模型文件不会上传。</p>
            </div>
          </div>
          <section class="card model-target">
            <label class="form-label" for="model-target-dir">模型保存目录</label>
            <div class="input-with-button">
              <input class="input" id="model-target-dir" value="${UI.escapeHtml(result.default_dir || "")}" />
              <button class="btn" id="model-pick-dir">选择目录</button>
            </div>
            <p class="form-help">默认保存到项目目录 ./models；可选任意可写目录。Whisper、Kokoro、Kanade 会分别保存到子目录，已有非空文件会跳过。Ollama 模型由 Ollama 自身管理，不使用此目录。</p>
          </section>
          <div id="model-download-status" class="card model-download-status" hidden></div>
          <div id="model-list" class="grid grid-2 mt-14"></div>
          <p class="form-help mt-14">文件模型由 Hugging Face 仓库提供。Ollama 模型拉取需要先安装并启动 Ollama。下载前请查看模型许可；大型权重需要充足磁盘空间和稳定网络。</p>`;

        const status = target.querySelector("#model-download-status");
        renderModels(target.querySelector("#model-list"), result.models || []);
        renderDownloadStatus(status, result.download, target);

        target.querySelector("#model-pick-dir").addEventListener("click", async () => {
          try {
            const selected = await API.must("choose_directory");
            if (selected.path) target.querySelector("#model-target-dir").value = selected.path;
          } catch (error) {
            UI.toast(error.message || "无法选择目录", "error");
          }
        });

        target.querySelectorAll(".model-download").forEach((button) => {
          button.addEventListener("click", async () => {
            button.disabled = true;
            try {
              const targetDir = target.querySelector("#model-target-dir").value.trim();
              if (button.dataset.kind !== "ollama" && !targetDir) {
                throw new Error("请选择模型保存目录");
              }
              const started = await API.must("start_model_download", button.dataset.modelId, targetDir);
              renderDownloadStatus(status, started.download, target);
            } catch (error) {
              button.disabled = false;
              UI.toast(error.message || "无法开始下载", "error", 6000);
            }
          });
        });

        status.addEventListener("click", async (event) => {
          if (!event.target.closest("#model-download-cancel")) return;
          try {
            const cancelled = await API.must("cancel_model_download");
            renderDownloadStatus(status, cancelled.download, target);
          } catch (error) {
            UI.toast(error.message || "无法取消下载", "error");
          }
        });

        const refreshStatus = async () => {
          if (polling) return;
          polling = true;
          try {
            const latest = await API.call("get_model_download_status");
            if (latest && latest.ok) renderDownloadStatus(status, latest.download, target);
          } catch (error) {
            console.warn("读取模型下载状态失败", error);
          } finally {
            polling = false;
          }
        };
        timer = window.setInterval(() => void refreshStatus(), 500);
        return { destroy: () => { if (timer !== null) window.clearInterval(timer); } };
      } catch (error) {
        target.innerHTML = `<div class="card">${UI.empty(error.message || "无法读取模型列表", "!")}</div>`;
        return { destroy: () => { if (timer !== null) window.clearInterval(timer); } };
      }
    },
  });
})();
