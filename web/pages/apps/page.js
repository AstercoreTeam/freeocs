(function () {
  "use strict";

  function moduleCard(pkg, module) {
    const state = (module && module.state) || {};
    const status = UI.packageStatusBadge(pkg);
    const platform = pkg.platform === "web" ? "网页" : (pkg.platform === "android" ? "手机" : "通用");
    const missing = new Set(pkg.missing || []);
    const capabilities = (pkg.requires || []).map((cap) =>
      `<span class="badge ${missing.has(cap) ? "danger" : "success"}">${UI.escapeHtml(cap)}</span>`
    ).join(" ");
    const icon = pkg.icon
      ? `<div class="module-icon" style="background:transparent;overflow:hidden;"><img src="${UI.escapeHtml(pkg.icon)}" alt="" style="width:100%;height:100%;object-fit:cover;"></div>`
      : `<div class="module-icon">${UI.escapeHtml((pkg.name || "?").slice(0, 1))}</div>`;
    const isRunning = Boolean(state.running);
    return `
      <div class="card" data-package="${UI.escapeHtml(pkg.id)}">
        <div class="card-head">
          <div class="flex gap-14 items-center">
            ${icon}
            <div>
              <div class="flex gap-8 items-center flex-wrap">
                <strong>${UI.escapeHtml(pkg.name)}</strong>
                <span class="badge primary">${platform}</span>
                <span class="badge ${status.cls}">${UI.escapeHtml(status.text)}</span>
                ${isRunning ? '<span class="badge success">运行中</span>' : ""}
              </div>
              <div class="list-sub">${UI.escapeHtml(pkg.description || "")}</div>
            </div>
          </div>
          <label class="switch" title="${pkg.enabled ? "禁用" : "启用"}">
            <input type="checkbox" data-enable="${UI.escapeHtml(pkg.id)}" ${pkg.enabled ? "checked" : ""}>
            <span></span>
          </label>
        </div>
        <div class="form-help">能力依赖：${capabilities || '<span class="muted">无</span>'}</div>
        ${(pkg.missing || []).length ? `<div class="form-help" style="color:var(--danger)">缺少：${UI.escapeHtml(pkg.missing.join(", "))}</div>` : ""}
        ${pkg.load_error ? `<div class="form-help" style="color:var(--danger)">${UI.escapeHtml(pkg.load_error)}</div>` : ""}
        <div class="form-actions">
          <button class="btn btn-primary btn-sm" data-open="${UI.escapeHtml(pkg.id)}" ${pkg.enabled && module && module.available ? "" : "disabled"}>打开</button>
          <button class="btn btn-sm" data-open-settings="${UI.escapeHtml(pkg.id)}">设置</button>
          <span class="text-sm muted">v${UI.escapeHtml(pkg.version)}${pkg.builtin ? " · 内置" : " · 外部"}</span>
        </div>
      </div>`;
  }

  function pluginRow(pkg) {
    const status = UI.packageStatusBadge(pkg);
    const provides = Object.keys(pkg.provides || {}).map((cap) =>
      `<span class="badge primary">${UI.escapeHtml(cap)}</span>`
    ).join(" ");
    return `
      <div class="list-row" data-package="${UI.escapeHtml(pkg.id)}">
        <div class="list-main">
          <div class="flex gap-8 items-center flex-wrap">
            <strong>${UI.escapeHtml(pkg.name)}</strong>
            <span class="badge ${status.cls}">${UI.escapeHtml(status.text)}</span>
            <span class="text-sm muted">v${UI.escapeHtml(pkg.version)}</span>
          </div>
          <div class="list-sub">${UI.escapeHtml(pkg.description || "")}</div>
          <div class="mt-8">${provides || '<span class="muted">未声明能力</span>'}</div>
          ${(pkg.dependencies || []).length ? `<div class="form-help">依赖：${UI.escapeHtml(pkg.dependencies.join(", "))}</div>` : ""}
        </div>
        <div class="flex gap-8 items-center">
          <button class="btn btn-sm" data-plugin-settings="${UI.escapeHtml(pkg.id)}">设置</button>
          <label class="switch" title="${pkg.enabled ? "禁用" : "启用"}">
            <input type="checkbox" data-enable="${UI.escapeHtml(pkg.id)}" ${pkg.enabled ? "checked" : ""}>
            <span></span>
          </label>
        </div>
      </div>`;
  }

  async function loadData() {
    const [packagesResult, modulesResult] = await Promise.all([
      API.must("list_packages"),
      API.must("list_modules"),
    ]);
    return {
      packages: packagesResult.packages || [],
      modules: modulesResult.modules || [],
    };
  }

  function render(root, data) {
    const modules = data.packages.filter((pkg) => pkg.type !== "plugin");
    const plugins = data.packages.filter((pkg) => pkg.type === "plugin");
    const moduleMap = new Map(data.modules.map((module) => [module.id, module]));
    root.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">应用与插件</h1>
          <p class="page-subtitle">应用模块接入具体学习平台；插件提供大模型、语音、OCR 等能力。</p>
        </div>
        <div class="page-actions">
          <button class="btn" id="apps-refresh">刷新</button>
          <button class="btn" id="apps-install">安装包…</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h3 class="card-title">应用模块</h3>
            <div class="card-subtitle">每个模块是一个独立 zip 包，声明所需能力。</div>
          </div>
          <span class="badge">${modules.length} 个</span>
        </div>
        ${modules.length ? `<div class="grid grid-2">${modules.map((pkg) => moduleCard(pkg, moduleMap.get(pkg.id))).join("")}</div>` : UI.empty("尚未安装应用模块。可安装 U校园 / 智慧树模块，或先安装一个包试用。", "▦")}
      </div>

      <div class="card mt-14">
        <div class="card-head">
          <div>
            <h3 class="card-title">能力插件</h3>
            <div class="card-subtitle">同一能力可以有多个提供者，在设置 → 能力绑定中切换。</div>
          </div>
          <span class="badge">${plugins.length} 个</span>
        </div>
        ${plugins.length ? `<div class="simple-list">${plugins.map(pluginRow).join("")}</div>` : UI.empty("尚未安装插件。", "◇")}
      </div>

      <div class="card mt-14">
        <h3 class="card-title">安装说明</h3>
        <p class="form-help">
          从“安装包…”选择 <code>.focpkg</code> 或 <code>.zip</code>。安装前会校验 manifest、路径与依赖；
          安装/更新后需要重启应用生效。安装第三方包等于允许它在你的电脑上执行代码，请只安装可信来源。
        </p>
      </div>`;

    root.querySelectorAll("[data-enable]").forEach((input) => {
      input.addEventListener("change", async () => {
        const id = input.dataset.enable;
        const enabled = input.checked;
        try {
          const result = await API.must("set_package_enabled", id, enabled);
          UI.toast(result.needs_restart ? "已保存，重启应用后生效" : "已更新", "success");
          await reload(root);
        } catch (error) {
          UI.toast(error.message || "更新失败", "error");
          input.checked = !enabled;
        }
      });
    });
    root.querySelectorAll("[data-open]").forEach((button) => {
      button.addEventListener("click", () => App.navigate("module", { id: button.dataset.open }));
    });
    root.querySelectorAll("[data-open-settings], [data-plugin-settings]").forEach((button) => {
      button.addEventListener("click", () => App.navigate("settings"));
    });
    root.querySelector("#apps-refresh").addEventListener("click", () => reload(root));
    root.querySelector("#apps-install").addEventListener("click", () => install(root));
  }

  async function reload(root) {
    try {
      const data = await loadData();
      render(root, data);
      await App.reloadBootstrap();
    } catch (error) {
      UI.toast(error.message || "刷新失败", "error");
    }
  }

  async function install(root) {
    try {
      const picked = await API.must("install_package_dialog");
      if (picked.cancelled) return;
      const inspect = await API.must("inspect_package", picked.path);
      const info = inspect.package || {};
      const deps = info.dependencies || [];
      const message = [
        `包：${info.name || ""} ${info.version || ""}`,
        `类型：${info.type || ""}`,
        `提供能力：${(info.provides && Object.keys(info.provides).join(", ")) || "无"}`,
        `需要能力：${(info.requires || []).join(", ") || "无"}`,
        deps.length ? `\nPython 依赖（安装时会尝试安装）：\n${deps.join("\n")}` : "",
        "\n第三方包会在本机执行代码，请确认来源可信。安装/更新后需要重启应用。",
      ].join("\n");
      const ok = await UI.modal({
        title: "安装包",
        message,
        confirmText: "安装",
        danger: deps.length > 0,
      });
      if (!ok) return;
      const result = await API.must("install_package", picked.path, deps.length > 0);
      UI.toast(`已安装 ${result.package ? result.package.name : ""}，重启后生效`, "success", 5000);
      await reload(root);
    } catch (error) {
      UI.toast(error.message || "安装失败", "error", 6000);
    }
  }

  window.definePage("apps", {
    async init(params, root) {
      const target = root.querySelector("#apps-root") || root;
      target.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在加载包…</div>';
      try {
        const data = await loadData();
        render(target, data);
      } catch (error) {
        target.innerHTML = `<div class="card">${UI.empty(error.message || "无法读取包列表", "!")}</div>`;
      }
      return { destroy: () => {} };
    },
  });
})();
