(function () {
  "use strict";

  async function testLLM(button) {
    const original = button.textContent;
    button.disabled = true;
    button.textContent = "测试中…";
    try {
      const result = await API.must("test_llm");
      await UI.modal({
        title: "大模型连接成功",
        message: `模型：${result.model || "?"}\n耗时：${result.latency_ms || 0} ms\n返回：${result.content || "(空)"}`,
        confirmText: "知道了",
        cancelText: "关闭",
      });
    } catch (error) {
      UI.toast(error.message || "连接失败", "error", 6000);
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  window.definePage("settings", {
    async init(params, root) {
      const target = root.querySelector("#settings-root") || root;
      target.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在读取设置…</div>';

      const load = async () => {
        const [schemaResult, valuesResult] = await Promise.all([
          API.must("get_settings_schema"),
          API.must("get_settings_values"),
        ]);
        return {
          sections: schemaResult.sections || [],
          values: valuesResult.values || {},
        };
      };

      const render = (data) => {
        target.innerHTML = `
          <div class="page-header">
            <div>
              <h1 class="page-title">设置</h1>
              <p class="page-subtitle">配置只保存在本机；API Key 不会显示在页面或日志中。</p>
            </div>
            <div class="page-actions">
              <button class="btn btn-sm" id="settings-test-llm">测试大模型</button>
              <button class="btn btn-sm" id="settings-open-config">打开配置目录</button>
              <button class="btn btn-sm" id="settings-refresh">刷新</button>
            </div>
          </div>
          <div id="settings-body"></div>`;
        const body = target.querySelector("#settings-body");
        SettingsUI.render(body, data.sections, data.values, reload);
        target.querySelector("#settings-test-llm").addEventListener("click", (event) => testLLM(event.currentTarget));
        target.querySelector("#settings-open-config").addEventListener("click", async () => {
          const info = (App.bootstrap && App.bootstrap.app) || {};
          try {
            await App.openPath(info.config_dir);
          } catch (error) {
            UI.toast(error.message || "无法打开目录", "error");
          }
        });
        target.querySelector("#settings-refresh").addEventListener("click", () => reload());
      };

      const reload = async () => {
        try {
          const data = await load();
          render(data);
          await App.reloadBootstrap();
        } catch (error) {
          UI.toast(error.message || "读取设置失败", "error");
        }
      };

      try {
        const data = await load();
        render(data);
      } catch (error) {
        target.innerHTML = `<div class="card">${UI.empty(error.message || "无法读取设置", "!")}</div>`;
      }
      return { destroy: () => {} };
    },
  });
})();
