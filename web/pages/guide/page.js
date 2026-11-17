/**
 * Copyright 2026 AstercoreTeam
 * Copyright 2026 qincnd <qincnd@qq.com>
 * Copyright 2026 XueZicheng <xuezicheng842@outlook.com>
 * SPDX-License-Identifier: AGPL-3.0-only
 */

(function () {
  "use strict";

  function steps(items) {
    return items.map((item, index) => `
      <div class="guide-step">
        <span class="guide-num">${index + 1}</span>
        <div class="guide-step-body">
          <strong>${UI.escapeHtml(item.title)}</strong>
          <p>${UI.escapeHtml(item.text)}</p>
          ${item.code ? `<pre class="guide-code">${UI.escapeHtml(item.code)}</pre>` : ""}
        </div>
      </div>`).join("");
  }

  function renderGuide(root, data, bridge, devices) {
    const browsers = data.browsers || [];
    const modules = data.modules || [];
    root.innerHTML = `
      <div class="page-header">
        <div>
          <h1 class="page-title">操作指南</h1>
          <p class="page-subtitle">从零完成配置：浏览器扩展、手机 ADB、大模型与媒体能力。</p>
        </div>
        <div class="page-actions">
          <button class="btn btn-sm" id="guide-refresh">刷新状态</button>
        </div>
      </div>

      <div class="grid grid-3">
        <div class="card stat-card">
          <div class="stat-label">本地中继</div>
          <div class="stat-value"><span class="dot ${bridge.connected ? "ok" : "warn"}"></span> ${bridge.connected ? "已连接" : "未连接"}</div>
          <div class="stat-hint mono">${UI.escapeHtml(data.server_url || "")}</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">检测到的浏览器</div>
          <div class="stat-value text-sm">${UI.escapeHtml(browsers.map((item) => item.name).join(" / ") || "未检测到")}</div>
          <div class="stat-hint">需要 Chrome / Edge / Firefox 之一</div>
        </div>
        <div class="card stat-card">
          <div class="stat-label">扩展目录</div>
          <div class="stat-value text-sm">${UI.escapeHtml(data.extension_dir || "")}</div>
          <div class="stat-hint">点击下方按钮打开</div>
        </div>
      </div>

      <div class="tabs mt-20" id="guide-tabs">
        <button class="tab active" data-tab="browser">浏览器扩展</button>
        <button class="tab" data-tab="android">手机 ADB</button>
        <button class="tab" data-tab="llm">大模型</button>
        <button class="tab" data-tab="media">媒体能力</button>
        <button class="tab" data-tab="modules">模块使用</button>
        <button class="tab" data-tab="faq">常见问题</button>
      </div>

      <div class="tab-panel active" data-panel="browser">
        <div class="guide-grid">
          <div class="card">
            <h3 class="card-title">Chrome / Edge / Brave</h3>
            <div class="card-subtitle">推荐使用 Chromium 内核浏览器。</div>
            ${steps([
              { title: "打开扩展目录", text: "点击右侧“打开 Chromium 扩展目录”，或在文件管理器中打开下面的路径。", code: data.chromium_dir || "" },
              { title: "进入扩展管理页", text: "在浏览器地址栏输入 chrome://extensions（Edge 为 edge://extensions）。" },
              { title: "开启开发者模式", text: "打开页面右上角的“开发者模式”。" },
              { title: "加载已解压的扩展", text: "点击“加载已解压的扩展程序”，选择第 1 步的目录。" },
              { title: "检测连接", text: "回到本页点击“检测连接”。连接成功后，打开目标学习网站并登录。" },
            ])}
            <div class="form-actions">
              <button class="btn btn-primary btn-sm" data-open-dir="chromium">打开 Chromium 扩展目录</button>
              <button class="btn btn-sm" data-copy="${UI.escapeHtml(data.chromium_dir || "")}">复制路径</button>
            </div>
          </div>

          <div class="card">
            <h3 class="card-title">Firefox</h3>
            <div class="card-subtitle">Firefox 使用临时加载，浏览器重启后需重新加载。</div>
            <div class="form-help">如果 Firefox 是 snap 版，扩展目录必须在非隐藏路径（本程序默认 <span class="mono">~/FreeOCS/extensions</span>）；放在 <span class="mono">~/.local/...</span> 会导致 background.js 加载失败。</div>
            ${steps([
              { title: "打开扩展目录", text: "点击下方“打开 Firefox 扩展目录”。", code: data.firefox_dir || "" },
              { title: "进入调试页", text: "在地址栏打开 about:debugging#/runtime/this-firefox。" },
              { title: "临时载入附加组件", text: "点击“临时载入附加组件”，选择该目录中的 manifest.json。" },
              { title: "检测连接", text: "回到本页点击“检测连接”。" },
            ])}
            <div class="form-actions">
              <button class="btn btn-primary btn-sm" data-open-dir="firefox">打开 Firefox 扩展目录</button>
              <button class="btn btn-sm" data-copy="${UI.escapeHtml(data.firefox_dir || "")}">复制路径</button>
            </div>
          </div>
        </div>

        <div class="card mt-14">
          <h3 class="card-title">连接状态</h3>
          <dl class="kv mt-8">
            <dt>状态</dt><dd><span class="dot ${bridge.connected ? "ok" : "warn"}"></span> ${bridge.connected ? "扩展已连接" : "未检测到扩展"}</dd>
            <dt>扩展版本</dt><dd>${UI.escapeHtml((bridge.info && bridge.info.version) || "—")}</dd>
            <dt>浏览器</dt><dd>${UI.escapeHtml((bridge.info && bridge.info.browser) || "—")}</dd>
            <dt>本地服务</dt><dd class="mono">${UI.escapeHtml(bridge.server || data.server_url || "")}</dd>
            <dt>提示</dt><dd>如果修改了端口，请同时修改扩展设置页中的端口。</dd>
          </dl>
          <div class="form-actions">
            <button class="btn btn-sm" id="guide-check-bridge">检测连接</button>
            <button class="btn btn-sm" id="guide-open-server">用浏览器打开本地服务</button>
          </div>
        </div>
      </div>

      <div class="tab-panel" data-panel="android">
        <div class="card">
          <h3 class="card-title">连接 Android 手机</h3>
          ${steps([
            { title: "开启开发者选项", text: "在手机“关于手机”中连续点击版本号，开启开发者选项。" },
            { title: "开启 USB 调试", text: "在开发者选项中打开“USB 调试”，用数据线连接电脑。" },
            { title: "允许调试授权", text: "手机上弹出“允许 USB 调试吗？”时选择允许。" },
            { title: "刷新设备", text: "点击下方“刷新设备”，应看到设备序列号与 device 状态。" },
            { title: "无线调试（可选）", text: "Android 11+ 可使用配对码；在终端执行以下命令。", code: "adb pair <ip:port>\nadb connect <ip:port>" },
          ])}
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" id="guide-refresh-adb">刷新设备</button>
            <button class="btn btn-sm" data-go="settings">打开设置</button>
          </div>
        </div>
        <div class="card mt-14">
          <h3 class="card-title">设备列表</h3>
          ${devices && devices.length ? `<div class="simple-list">${devices.map((device) => `
            <div class="list-row">
              <div class="list-main">
                <div class="list-title mono">${UI.escapeHtml(device.serial)}</div>
                <div class="list-sub">${UI.escapeHtml(device.raw || "")}</div>
              </div>
              <span class="badge ${device.state === "device" ? "success" : "danger"}">${UI.escapeHtml(device.state)}</span>
            </div>`).join("")}</div>` : UI.empty("尚未检测到设备。连接手机后点击“刷新设备”。", "□")}
        </div>
      </div>

      <div class="tab-panel" data-panel="llm">
        <div class="card">
          <h3 class="card-title">配置全局文本模型</h3>
          <p class="form-help">FreeOCS 默认只有一套文本模型配置，供答题、总结等场景使用。支持任意 OpenAI 兼容的 <code>/chat/completions</code> 服务。</p>
          ${steps([
            { title: "填写 API 地址", text: "例如 https://api.deepseek.com 或 https://api.openai.com/v1。", code: "https://api.deepseek.com" },
            { title: "填写 API Key", text: "在设置 → 大模型中填写，保存后只显示“已配置”。" },
            { title: "填写模型名", text: "例如 deepseek-flash、gpt-4o-mini、qwen2.5:7b。" },
            { title: "测试连接", text: "在设置页点击“测试大模型”，确认返回正常。" },
          ])}
          <div class="form-actions">
            <button class="btn btn-primary btn-sm" data-go="settings">打开大模型设置</button>
          </div>
          <p class="form-help mt-8">需要 function calling 的模块（如智慧树 Agent）要求模型支持 tools。</p>
        </div>
      </div>

      <div class="tab-panel" data-panel="media">
        <div class="grid grid-3">
          <div class="card">
            <h3 class="card-title">语音转写</h3>
            <p class="form-help">本地 faster-whisper，或安装云端 ASR 插件。U校园听力题依赖此能力。</p>
            <div class="form-actions"><button class="btn btn-sm" data-go="settings">配置 ASR</button></div>
          </div>
          <div class="card">
            <h3 class="card-title">图片 OCR</h3>
            <p class="form-help">RapidOCR 本地识别截图文字与坐标，用于手机控件树不可用时的兜底。</p>
            <div class="form-actions"><button class="btn btn-sm" data-go="settings">配置 OCR</button></div>
          </div>
          <div class="card">
            <h3 class="card-title">语音合成</h3>
            <p class="form-help">系统 TTS 或 edge-tts；用于口语题答案音频生成。</p>
            <div class="form-actions"><button class="btn btn-sm" data-go="settings">配置 TTS</button></div>
          </div>
        </div>
        <div class="card mt-14">
          <h3 class="card-title">模型与依赖</h3>
          <p class="form-help">本地 ASR 模型不随安装包分发。将 faster-whisper 模型放到数据目录 models/ 下，或到设置中指定目录。缺少依赖时模块会给出可读错误，不会静默失败。</p>
        </div>
      </div>

      <div class="tab-panel" data-panel="modules">
        <div class="card">
          <h3 class="card-title">模块使用</h3>
          ${modules.length ? `<div class="simple-list">${modules.map((module) => `
            <div class="list-row">
              <div class="list-main">
                <div class="list-title">${UI.escapeHtml(module.name)} <span class="badge">${UI.escapeHtml(module.platform)}</span></div>
                <div class="list-sub">${UI.escapeHtml(module.description || "")}</div>
              </div>
              <button class="btn btn-sm" data-open-module="${UI.escapeHtml(module.id)}" ${module.available ? "" : "disabled"}>打开</button>
            </div>`).join("")}</div>` : UI.empty("尚未启用应用模块。到“应用与插件”安装或启用模块。", "▦")}
        </div>
        <div class="card mt-14">
          <h3 class="card-title">通用流程</h3>
          ${steps([
            { title: "连接目标", text: "网页模块需要浏览器扩展已连接并登录目标网站；手机模块需要 ADB 设备已授权。" },
            { title: "打开模块", text: "在“应用与插件”中点击“打开”，检查能力状态。" },
            { title: "开始", text: "点击“开始”，观察状态与日志。" },
            { title: "手动提交", text: "遇到提交/交卷/发布页面时模块会停止。请核对答案后手动完成。" },
          ])}
        </div>
      </div>

      <div class="tab-panel" data-panel="faq">
        <div class="card">
          <h3 class="card-title">常见问题</h3>
          <details class="mt-8"><summary>为什么开始按钮是灰的？</summary><p class="form-help">模块不可用：可能缺少能力提供者（例如未安装 LLM/ASR 插件），或扩展/设备未连接。到“应用与插件”和日志页查看原因。</p></details>
          <details class="mt-8"><summary>为什么停在“等待手动提交”？</summary><p class="form-help">这是安全模式：FreeOCS 不会点击提交/交卷/发布。请核对页面答案后手动提交。</p></details>
          <details class="mt-8"><summary>浏览器扩展连接不上？</summary><p class="form-help">确认扩展已加载、已启用；确认本地服务端口与扩展设置一致；刷新目标页面；重启浏览器后 Firefox 临时扩展需要重新加载。</p></details>
          <details class="mt-8"><summary>听力转写失败？</summary><p class="form-help">检查 ASR 插件是否启用、模型目录是否正确、音频 URL 是否需要登录/Referer。失败时模块会停止而不是猜测。</p></details>
          <details class="mt-8"><summary>模型返回无法匹配选项？</summary><p class="form-help">可能是模型输出格式不稳定或页面选项文本特殊。查看日志中的 raw 输出；换用更稳定的模型或降低温度。</p></details>
          <details class="mt-8"><summary>如何完全清除数据？</summary><p class="form-help">退出应用后删除配置目录与数据目录。路径见“关于”或设置页“打开配置目录”。</p></details>
        </div>
      </div>`;

    root.querySelectorAll("[data-tab]").forEach((button) => {
      button.addEventListener("click", () => {
        root.querySelectorAll("#guide-tabs .tab").forEach((tab) => tab.classList.toggle("active", tab === button));
        root.querySelectorAll("[data-panel]").forEach((panel) => panel.classList.toggle("active", panel.dataset.panel === button.dataset.tab));
      });
    });
    root.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => App.navigate(el.dataset.go)));
    root.querySelectorAll("[data-open-module]").forEach((el) => el.addEventListener("click", () => App.navigate("module", { id: el.dataset.openModule })));
    root.querySelectorAll("[data-copy]").forEach((el) => {
      el.addEventListener("click", async () => {
        const ok = await UI.copyText(el.dataset.copy);
        UI.toast(ok ? "路径已复制" : "复制失败，请手动选择", ok ? "success" : "error");
      });
    });
    root.querySelectorAll("[data-open-dir]").forEach((el) => {
      el.addEventListener("click", async () => {
        const path = el.dataset.openDir === "firefox" ? data.firefox_dir : data.chromium_dir;
        try {
          await App.openPath(path);
        } catch (error) {
          UI.toast(`${error.message || "无法打开目录"}（扩展可能尚未构建）`, "error", 5000);
        }
      });
    });
    root.querySelector("#guide-check-bridge").addEventListener("click", async () => {
      try {
        const result = await API.must("get_bridge_status");
        UI.toast(result.bridge && result.bridge.connected ? "扩展已连接" : "仍未检测到扩展", result.bridge && result.bridge.connected ? "success" : "warn");
        await refresh();
      } catch (error) {
        UI.toast(error.message || "检测失败", "error");
      }
    });
    root.querySelector("#guide-open-server").addEventListener("click", () => {
      App.openExternal(data.server_url).catch((error) => UI.toast(error.message, "error"));
    });
    root.querySelector("#guide-refresh-adb").addEventListener("click", async () => {
      try {
        const result = await API.must("refresh_android_devices");
        UI.toast(`检测到 ${(result.devices || []).length} 台设备`, "success");
        await refresh();
      } catch (error) {
        UI.toast(error.message || "刷新设备失败", "error");
      }
    });
    root.querySelector("#guide-refresh").addEventListener("click", () => refresh());

    async function refresh() {
      const [guideResult, bridgeResult, devicesResult] = await Promise.all([
        API.must("get_guide_data"),
        API.must("get_bridge_status"),
        API.call("refresh_android_devices"),
      ]);
      const newData = guideResult;
      const newBridge = bridgeResult.bridge || {};
      const newDevices = (devicesResult && devicesResult.devices) || [];
      const activeTab = (root.querySelector("#guide-tabs .tab.active") || {}).dataset;
      renderGuide(root, newData, newBridge, newDevices);
      if (activeTab && activeTab.tab) {
        const tab = root.querySelector(`#guide-tabs .tab[data-tab="${activeTab.tab}"]`);
        if (tab) tab.click();
      }
    }
  }

  window.definePage("guide", {
    async init(params, root) {
      const target = root.querySelector("#guide-root") || root;
      target.innerHTML = '<div class="page-loading"><span class="spinner"></span> 正在读取指南…</div>';
      try {
        const [guideResult, bridgeResult, devicesResult, modulesResult] = await Promise.all([
          API.must("get_guide_data"),
          API.must("get_bridge_status"),
          API.call("refresh_android_devices"),
          API.call("list_modules"),
        ]);
        const data = Object.assign({}, guideResult, {
          modules: (modulesResult && modulesResult.modules) || [],
        });
        renderGuide(target, data, bridgeResult.bridge || {}, (devicesResult && devicesResult.devices) || []);
      } catch (error) {
        target.innerHTML = `<div class="card">${UI.empty(error.message || "无法读取指南", "!")}</div>`;
      }
      return { destroy: () => {} };
    },
  });
})();
