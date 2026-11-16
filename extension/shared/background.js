/* FreeOCS browser bridge - background service worker / event page. */
const ext = globalThis.browser || globalThis.chrome;
const VERSION = "0.1.2";
const CLIENT_HEADER = "X-FreeOCS-Client";
const CLIENT_VALUE = "browser-bridge";
const DEFAULT_PORT = 8765;

let config = { port: DEFAULT_PORT, enabled: true };
let polling = false;
let lastError = "";
let targetTabId = null;

function baseUrl() {
  return `http://127.0.0.1:${config.port}`;
}

function clientHeaders(extra) {
  return Object.assign(
    { [CLIENT_HEADER]: CLIENT_VALUE, "X-FreeOCS-Extension-Version": VERSION },
    extra || {}
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function browserName() {
  const ua = navigator.userAgent || "";
  if (/Firefox\//.test(ua)) return "firefox";
  if (/Edg\//.test(ua)) return "edge";
  if (/Chrome\//.test(ua)) return "chrome";
  return "unknown";
}

async function loadConfig() {
  try {
    const stored = await ext.storage.local.get({ port: DEFAULT_PORT, enabled: true });
    config.port = Number(stored.port) || DEFAULT_PORT;
    config.enabled = stored.enabled !== false;
  } catch (error) {
    console.warn("[FreeOCS] storage unavailable", error);
  }
}

async function register() {
  try {
    const response = await fetch(`${baseUrl()}/extension/register`, {
      method: "POST",
      headers: clientHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        browser: browserName(),
        version: VERSION,
        extension_id: ext.runtime.id || "",
        user_agent: navigator.userAgent,
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    lastError = "";
  } catch (error) {
    lastError = String(error && error.message ? error.message : error);
  }
}

function isHttpTab(tab) {
  return Boolean(tab && tab.id && /^https?:/i.test(tab.url || ""));
}

async function getTargetTab() {
  if (targetTabId !== null) {
    try {
      const existing = await ext.tabs.get(targetTabId);
      if (isHttpTab(existing)) return existing;
    } catch (error) {
      /* target tab closed */
    }
    targetTabId = null;
  }
  // Look at active tabs in *all* windows, not just the window the extension
  // background page happens to be associated with.
  const activeTabs = (await ext.tabs.query({ active: true })).filter(isHttpTab);
  if (activeTabs.length) {
    activeTabs.sort((left, right) => (right.lastAccessed || 0) - (left.lastAccessed || 0));
    targetTabId = activeTabs[0].id;
    return activeTabs[0];
  }
  const allTabs = (await ext.tabs.query({})).filter(isHttpTab);
  if (!allTabs.length) throw new Error("没有可操作的 http(s) 标签页");
  targetTabId = allTabs[0].id;
  return allTabs[0];
}

async function sendToTab(tabId, message) {
  try {
    return await ext.tabs.sendMessage(tabId, message);
  } catch (error) {
    // Content script may not be injected yet (e.g. extension loaded after page).
    try {
      await ext.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    } catch (injectError) {
      throw new Error(`无法注入 content script：${injectError.message || injectError}`);
    }
    return await ext.tabs.sendMessage(tabId, message);
  }
}

async function fetchAsBase64(url, options) {
  const response = await fetch(url, options);
  const buffer = await response.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body_base64: btoa(binary),
  };
}

async function dispatch(task) {
  const action = task.action;
  const args = task.args || {};
  if (action === "dom.call") {
    const tab = await getTargetTab();
    const result = await sendToTab(tab.id, {
      type: "freeocs:dom",
      method: args.method,
      args: args.args || [],
    });
    if (result && result.error) throw new Error(result.error);
    return result ? result.result : null;
  }
  if (action === "page.info") {
    const tab = await getTargetTab();
    let info = {};
    try {
      const result = await sendToTab(tab.id, { type: "freeocs:dom", method: "getPageInfo", args: [] });
      info = (result && result.result) || {};
    } catch (error) {
      info = { error: String(error.message || error) };
    }
    return Object.assign({ id: tab.id, url: tab.url, title: tab.title, active: Boolean(tab.active), target: true }, info);
  }
  if (action === "page.navigate") {
    const tab = await getTargetTab();
    if (!args.url || !/^https?:/i.test(args.url)) throw new Error("只允许 http(s) 导航");
    await ext.tabs.update(tab.id, { url: args.url });
    return { ok: true, url: args.url };
  }
  if (action === "tabs.list") {
    const tabs = await ext.tabs.query({});
    return tabs.map((tab) => ({
      id: tab.id,
      url: tab.url || "",
      title: tab.title || "",
      active: Boolean(tab.active),
      target: tab.id === targetTabId,
      windowId: tab.windowId,
    }));
  }
  if (action === "tabs.activate") {
    const pattern = String(args.url_pattern || "");
    if (!pattern) throw new Error("缺少 url_pattern");
    const tabs = await ext.tabs.query({});
    const tab = tabs.find((item) => (item.url || "").includes(pattern) || (item.title || "").includes(pattern));
    if (!tab) throw new Error(`未找到匹配标签页：${pattern}`);
    await ext.tabs.update(tab.id, { active: true });
    targetTabId = tab.id;
    if (tab.windowId) {
      try { await ext.windows.update(tab.windowId, { focused: true }); } catch (error) { /* ignore */ }
    }
    return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title, target: true } };
  }
  if (action === "tabs.target") {
    const tabId = args.tab_id;
    if (tabId === undefined || tabId === null || tabId === "") throw new Error("缺少 tab_id");
    let tab;
    try {
      tab = await ext.tabs.get(Number(tabId));
    } catch (error) {
      throw new Error(`标签页不存在：${tabId}`);
    }
    if (!isHttpTab(tab)) throw new Error("目标标签页不是 http(s) 页面");
    targetTabId = tab.id;
    return { ok: true, tab: { id: tab.id, url: tab.url, title: tab.title, target: true } };
  }
  if (action === "agent.eval") {
    const tab = await getTargetTab();
    const result = await sendToTab(tab.id, { type: "freeocs:eval", code: String(args.code || "") });
    if (result && result.error) throw new Error(result.error);
    return result ? result.result : null;
  }
  if (action === "fetch") {
    if (!args.url || !/^https?:/i.test(args.url)) throw new Error("只允许 http(s) 下载");
    return await fetchAsBase64(args.url, {
      method: args.method || "GET",
      headers: args.headers || {},
    });
  }
  if (action === "ping") {
    return { ok: true, version: VERSION };
  }
  throw new Error(`未知动作：${action}`);
}

async function pollLoop() {
  if (polling) return;
  polling = true;
  while (config.enabled) {
    try {
      const response = await fetch(`${baseUrl()}/extension/poll?timeout=25`, {
        headers: clientHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const task = await response.json();
      if (!task || !task.id) continue;
      let payload;
      try {
        payload = { id: task.id, ok: true, result: await dispatch(task) };
      } catch (error) {
        payload = { id: task.id, ok: false, error: String(error && error.message ? error.message : error) };
      }
      await fetch(`${baseUrl()}/extension/result`, {
        method: "POST",
        headers: clientHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(payload),
      });
    } catch (error) {
      lastError = String(error && error.message ? error.message : error);
      await sleep(2000);
    }
  }
  polling = false;
}

async function handleMessage(message, sender) {
  if (!message || typeof message !== "object") return null;
  if (message.type === "freeocs:get-agents") {
    try {
      const url = encodeURIComponent(message.url || (sender.tab && sender.tab.url) || "");
      const token = encodeURIComponent(message.token || "");
      const response = await fetch(`${baseUrl()}/extension/agents?url=${url}&token=${token}`, {
        headers: clientHeaders(),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      return { agents: [], error: String(error && error.message ? error.message : error) };
    }
  }
  if (message.type === "freeocs:api") {
    const path = String(message.path || "");
    if (!path.startsWith("/api/module/")) {
      return { ok: false, error: "只允许访问模块接口" };
    }
    const pageUrl = String(message.pageUrl || (sender.tab && sender.tab.url) || "");
    let origin = "";
    try { origin = new URL(pageUrl).origin; } catch (error) { origin = ""; }
    try {
      const response = await fetch(`${baseUrl()}${path}`, {
        method: message.method || "POST",
        headers: clientHeaders({
          "Content-Type": "application/json",
          "X-FreeOCS-Page-URL": pageUrl,
          "X-FreeOCS-Page-Origin": origin,
          "X-FreeOCS-Tab-Id": sender.tab && sender.tab.id != null ? String(sender.tab.id) : "",
        }),
        body: JSON.stringify(message.body || {}),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        return { ok: false, error: (data && data.error) || `HTTP ${response.status}` };
      }
      return data;
    } catch (error) {
      return { ok: false, error: String(error && error.message ? error.message : error) };
    }
  }
  if (message.type === "freeocs:log") {
    try {
      await fetch(`${baseUrl()}/extension/log`, {
        method: "POST",
        headers: clientHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          message: String(message.message || ""),
          level: message.level || "info",
          page_url: (sender.tab && sender.tab.url) || "",
        }),
      });
    } catch (error) {
      /* logging must never break the page */
    }
    return { ok: true };
  }
  if (message.type === "freeocs:status") {
    return { ok: true, config, lastError, version: VERSION, browser: browserName() };
  }
  return null;
}

ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const promise = handleMessage(message, sender);
  if (!promise) return false;
  promise.then((result) => sendResponse(result)).catch((error) => sendResponse({ ok: false, error: String(error) }));
  return true;
});

ext.runtime.onInstalled.addListener(() => {
  register();
  pollLoop();
});
ext.runtime.onStartup.addListener(() => {
  register();
  pollLoop();
});
ext.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.port) config.port = Number(changes.port.newValue) || DEFAULT_PORT;
  if (changes.enabled) config.enabled = changes.enabled.newValue !== false;
  if (config.enabled) pollLoop();
});

(async function start() {
  await loadConfig();
  await register();
  pollLoop();
})();
