/* Schema-driven settings renderer. */
(function () {
  "use strict";

  const GROUP_LABELS = {
    core: "框架设置",
    capability: "能力绑定",
    plugin: "插件设置",
    module: "模块设置",
  };

  function fieldId(sectionId, key) {
    return `field-${sectionId}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  }

  function sectionValues(values, section) {
    if (section.id === "capabilities") {
      const result = Object.assign({}, values.capabilities || {});
      for (const field of section.fields || []) {
        if (result[field.key] == null && field.default != null) result[field.key] = field.default;
      }
      return result;
    }
    return Object.assign({}, values[section.id] || {});
  }

  function renderField(section, field, current, hasValue) {
    const id = fieldId(section.id, field.key);
    const label = UI.escapeHtml(field.label || field.key);
    const required = field.required ? '<span class="required">*</span>' : "";
    const help = field.help ? `<div class="form-help">${UI.escapeHtml(field.help)}</div>` : "";
    let control = "";

    if (field.type === "info") {
      return `<div class="form-row"><div class="form-help">${UI.escapeHtml(field.label || "")}</div></div>`;
    }

    if (field.type === "boolean") {
      return `
        <div class="form-row">
          <div class="checkbox-row">
            <div>
              <div class="form-label"><label for="${id}">${label}${required}</label></div>
              ${help}
            </div>
            <label class="switch">
              <input type="checkbox" id="${id}" data-key="${UI.escapeHtml(field.key)}" ${current ? "checked" : ""}>
              <span></span>
            </label>
          </div>
        </div>`;
    }

    if (field.type === "select") {
      const options = (field.options || []).map((option) => {
        const value = String(option.value == null ? "" : option.value);
        const selected = String(current == null ? "" : current) === value ? "selected" : "";
        return `<option value="${UI.escapeHtml(value)}" ${selected}>${UI.escapeHtml(option.label || value)}</option>`;
      }).join("");
      control = `<select class="select" id="${id}" data-key="${UI.escapeHtml(field.key)}">${options}</select>`;
      return `<div class="form-row"><label class="form-label" for="${id}">${label}${required}</label>${control}${help}</div>`;
    }

    if (field.type === "textarea") {
      control = `<textarea class="textarea" id="${id}" data-key="${UI.escapeHtml(field.key)}" rows="${field.rows || 4}" placeholder="${UI.escapeHtml(field.placeholder || "")}">${UI.escapeHtml(current || "")}</textarea>`;
      return `<div class="form-row"><label class="form-label" for="${id}">${label}${required}</label>${control}${help}</div>`;
    }

    if (field.type === "password") {
      const configured = Boolean(hasValue);
      control = `
        <input class="input" id="${id}" data-key="${UI.escapeHtml(field.key)}" type="password"
          autocomplete="new-password" placeholder="${UI.escapeHtml(configured ? "已配置，留空保留原值" : (field.placeholder || "未配置"))}">
        <div class="form-inline mt-8">
          <span class="password-state">${configured ? "已配置" : "未配置"}</span>
          ${configured ? `<label class="form-inline text-sm"><input type="checkbox" data-clear-key="${UI.escapeHtml(field.key)}"> 保存时清除</label>` : ""}
        </div>`;
      return `<div class="form-row"><label class="form-label" for="${id}">${label}${required}</label>${control}${help}</div>`;
    }

    if (field.type === "path") {
      control = `
        <div class="input-with-button">
          <input class="input" id="${id}" data-key="${UI.escapeHtml(field.key)}" value="${UI.escapeHtml(current || "")}" placeholder="${UI.escapeHtml(field.placeholder || "")}">
          <button class="btn btn-sm" type="button" data-choose-path="${UI.escapeHtml(field.key)}" data-path-mode="${field.mode || "dir"}">选择…</button>
        </div>`;
      return `<div class="form-row"><label class="form-label" for="${id}">${label}${required}</label>${control}${help}</div>`;
    }

    const type = field.type === "number" || field.type === "integer" ? "number" : "text";
    const step = field.step != null ? `step="${field.step}"` : (field.type === "integer" ? 'step="1"' : "");
    const min = field.min != null ? `min="${field.min}"` : "";
    const max = field.max != null ? `max="${field.max}"` : "";
    control = `<input class="input" id="${id}" data-key="${UI.escapeHtml(field.key)}" type="${type}" ${step} ${min} ${max} value="${UI.escapeHtml(current == null ? "" : current)}" placeholder="${UI.escapeHtml(field.placeholder || "")}">`;
    return `<div class="form-row"><label class="form-label" for="${id}">${label}${required}</label>${control}${help}</div>`;
  }

  function renderSection(section, values) {
    const currentValues = sectionValues(values, section);
    const hasValueMap = currentValues.__has_value || {};
    const fields = (section.fields || []).map((field) =>
      renderField(section, field, currentValues[field.key], hasValueMap[field.key])
    ).join("");
    return `
      <section class="card" id="settings-section-${UI.escapeHtml(section.id)}" data-section="${UI.escapeHtml(section.id)}">
        <div class="card-head">
          <div>
            <h3 class="card-title">${UI.escapeHtml(section.title || section.id)}</h3>
            ${section.description ? `<div class="card-subtitle">${UI.escapeHtml(section.description)}</div>` : ""}
          </div>
          <div class="flex gap-8">
            <button class="btn btn-sm" data-reset-section>恢复默认</button>
            <button class="btn btn-primary btn-sm" data-save-section>保存</button>
          </div>
        </div>
        <div class="form-section">${fields || '<div class="muted">暂无设置项</div>'}</div>
      </section>`;
  }

  async function saveSection(sectionEl, section) {
    const sectionId = section.id;
    const values = {};
    sectionEl.querySelectorAll("[data-key]").forEach((input) => {
      const key = input.dataset.key;
      if (input.type === "checkbox" && input.closest(".switch")) {
        values[key] = Boolean(input.checked);
      } else if (input.type === "checkbox") {
        return;
      } else if (input.type === "number") {
        values[key] = input.value === "" ? null : Number(input.value);
      } else {
        values[key] = input.value;
      }
    });
    sectionEl.querySelectorAll("[data-clear-key]").forEach((checkbox) => {
      if (checkbox.checked) values[checkbox.dataset.clearKey] = null;
    });
    const buttons = sectionEl.querySelectorAll("button");
    buttons.forEach((button) => { button.disabled = true; });
    try {
      await API.must("save_settings", sectionId, values);
      UI.toast("设置已保存", "success");
      return true;
    } catch (error) {
      UI.toast(error.message || "保存失败", "error", 5000);
      return false;
    } finally {
      buttons.forEach((button) => { button.disabled = false; });
    }
  }

  async function choosePath(input, mode, key) {
    try {
      const result = mode === "file" ? await API.must("choose_file") : await API.must("choose_directory");
      if (result.cancelled) return;
      if (result.path) {
        input.value = result.path;
        input.dataset.key = key;
      }
    } catch (error) {
      UI.toast(error.message || "无法选择路径", "error");
    }
  }

  function bindSection(sectionEl, section, reload) {
    sectionEl.querySelector("[data-save-section]").addEventListener("click", async () => {
      const ok = await saveSection(sectionEl, section);
      if (ok && reload) await reload();
    });
    sectionEl.querySelector("[data-reset-section]").addEventListener("click", async () => {
      const ok = await UI.modal({
        title: "恢复默认",
        message: `确定把“${section.title || section.id}”恢复为默认值吗？`,
        confirmText: "恢复",
        danger: true,
      });
      if (!ok) return;
      try {
        await API.must("reset_settings", section.id);
        UI.toast("已恢复默认值", "success");
        if (reload) await reload();
      } catch (error) {
        UI.toast(error.message || "恢复失败", "error");
      }
    });
    sectionEl.querySelectorAll("[data-choose-path]").forEach((button) => {
      const key = button.dataset.choosePath;
      const mode = button.dataset.pathMode;
      const input = sectionEl.querySelector(`[data-key="${CSS.escape(key)}"]`);
      button.addEventListener("click", () => choosePath(input, mode, key));
    });
  }

  function groupSections(sections) {
    const groups = new Map();
    for (const section of sections) {
      const group = section.group || "core";
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group).push(section);
    }
    const order = ["core", "capability", "plugin", "module"];
    return order.filter((key) => groups.has(key)).map((key) => ({ key, label: GROUP_LABELS[key] || key, sections: groups.get(key) }));
  }

  function render(container, sections, values, reload) {
    const groups = groupSections(sections || []);
    const nav = groups.map((group) => `
      <div class="nav-section">${UI.escapeHtml(group.label)}</div>
      ${group.sections.map((section) => `<div class="nav-item" data-goto="${UI.escapeHtml(section.id)}">${UI.escapeHtml(section.title || section.id)}</div>`).join("")}
    `).join("");
    const content = groups.map((group) => `
      <div class="settings-group" data-group="${UI.escapeHtml(group.key)}">
        <h2 class="page-subtitle" style="margin: 4px 0 10px; font-weight: 600;">${UI.escapeHtml(group.label)}</h2>
        ${group.sections.map((section) => renderSection(section, values || {})).join("")}
      </div>
    `).join("");

    container.innerHTML = `
      <div class="settings-layout" style="display:grid;grid-template-columns:200px minmax(0,1fr);gap:18px;align-items:start;">
        <aside class="card" style="position:sticky;top:0;padding:10px;">${nav}</aside>
        <div class="settings-content">${content || UI.empty("没有可配置项")}</div>
      </div>`;

    container.querySelectorAll("[data-goto]").forEach((item) => {
      item.addEventListener("click", () => {
        const target = document.getElementById(`settings-section-${item.dataset.goto}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    });
    for (const group of groups) {
      for (const section of group.sections) {
        const sectionEl = container.querySelector(`#settings-section-${CSS.escape(section.id)}`);
        if (sectionEl) bindSection(sectionEl, section, reload);
      }
    }
  }

  window.SettingsUI = { render };
})();
