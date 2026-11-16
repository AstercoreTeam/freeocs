/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

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
