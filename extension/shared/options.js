const ext = globalThis.browser || globalThis.chrome;
const VERSION = ext.runtime.getManifest().version;

const portInput = document.getElementById("port");
const enabledInput = document.getElementById("enabled");
const statusEl = document.getElementById("status");
const versionEl = document.getElementById("version");

versionEl.textContent = VERSION;

function setStatus(text, cls) {
  statusEl.innerHTML = `<span class="${cls || ""}">${text}</span>`;
}

async function load() {
  const stored = await ext.storage.local.get({ port: 8765, enabled: true });
  portInput.value = stored.port || 8765;
  enabledInput.checked = stored.enabled !== false;
  setStatus("配置已读取");
}

async function save() {
  const port = Number(portInput.value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    setStatus("端口必须是 1024–65535 的整数", "bad");
    return;
  }
  await ext.storage.local.set({ port, enabled: enabledInput.checked });
  setStatus("已保存，正在检测连接…");
  await test();
}

async function test() {
  const port = Number(portInput.value) || 8765;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { cache: "no-store" });
    const data = await response.json();
    setStatus(`已连接 FreeOCS ${data.version || ""}（${data.name || "服务"}），端口 ${port}`, "ok");
  } catch (error) {
    setStatus(`无法连接 127.0.0.1:${port}\n请确认 FreeOCS 正在运行、端口一致。\n${error.message || error}`, "bad");
  }
}

document.getElementById("save").addEventListener("click", save);
document.getElementById("test").addEventListener("click", test);

load();
