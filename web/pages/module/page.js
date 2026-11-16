(function () {
  "use strict";

  window.definePage("module", {
    async init(params, root) {
      const target = root.querySelector("#module-root") || root;
      const moduleId = (params && params.id) || "";
      if (!moduleId) {
        target.innerHTML = `<div class="card">${UI.empty("缺少模块 ID", "!")}</div>`;
        return { destroy: () => {} };
      }
      const page = ModuleUI.open(target, moduleId);
      return { destroy: () => page.destroy() };
    },
  });
})();
