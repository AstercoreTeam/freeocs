/* FreeOCS content script: DOM bridge + trusted page-agent loader. */
(() => {
  const ext = globalThis.browser || globalThis.chrome;
  const AGENT_TOKEN = `foc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const BASE = "http://127.0.0.1:8765";

  try { document.documentElement.dataset.freeocsContent = "1"; } catch (error) {}

  function pageInfo() {
    return {
      url: location.href,
      title: document.title,
      host: location.host,
      origin: location.origin,
      readyState: document.readyState,
      frame: window.top === window ? "top" : "child",
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
  }

  const actions = {
    getHTML: (selector) => {
      if (selector) {
        const el = document.querySelector(selector);
        return el ? el.outerHTML : null;
      }
      return document.documentElement ? document.documentElement.outerHTML : "";
    },
    getText: (selector) => document.querySelector(selector)?.textContent ?? null,
    getAttr: (selector, name) => document.querySelector(selector)?.getAttribute(name) ?? null,
    getValue: (selector) => document.querySelector(selector)?.value ?? null,
    queryAll: (selector) =>
      [...document.querySelectorAll(selector)].map((el) => ({
        tag: el.tagName.toLowerCase(),
        id: el.id || "",
        class: typeof el.className === "string" ? el.className : "",
        text: (el.textContent || "").slice(0, 200),
      })),
    click: (selector) => {
      const el = document.querySelector(selector);
      if (el) el.click();
      return Boolean(el);
    },
    setValue: (selector, value) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    },
    setHTML: (selector, html) => {
      const el = document.querySelector(selector);
      if (el) el.innerHTML = html;
      return Boolean(el);
    },
    setAttr: (selector, name, value) => {
      const el = document.querySelector(selector);
      if (el) el.setAttribute(name, value);
      return Boolean(el);
    },
    remove: (selector) => {
      const el = document.querySelector(selector);
      if (el) el.remove();
      return Boolean(el);
    },
    scrollTo: (selector) => {
      document.querySelector(selector)?.scrollIntoView({ behavior: "smooth", block: "center" });
      return true;
    },
    scrollBy: (x, y) => {
      window.scrollBy(Number(x) || 0, Number(y) || 0);
      return true;
    },
    waitFor: (selector, timeout = 5000) =>
      new Promise((resolve) => {
        if (document.querySelector(selector)) return resolve(true);
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector)) {
            observer.disconnect();
            resolve(true);
          }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setTimeout(() => {
          observer.disconnect();
          resolve(false);
        }, Number(timeout) || 5000);
      }),
    getPageInfo: () => pageInfo(),
  };

  function sendLog(level, message) {
    try {
      ext.runtime.sendMessage({
        type: "freeocs:log",
        level: level || "info",
        message: String(message || ""),
      });
    } catch (error) {
      /* ignore */
    }
  }

  function respond(id, response) {
    const ok = Boolean(response && response.ok === true);
    window.postMessage(
      {
        __freeocsAgent: true,
        token: AGENT_TOKEN,
        type: "freeocs:response",
        id,
        ok,
        result: ok ? response.result : undefined,
        error: ok ? undefined : (response && response.error) || "本地服务请求失败",
      },
      "*"
    );
  }

  // The page agent runs in the page's main world (served by the local server).
  // It talks to this content script through a token-scoped postMessage bridge.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__freeocsAgent !== true || data.token !== AGENT_TOKEN) return;
    if (data.type === "freeocs:request") {
      ext.runtime
        .sendMessage({
          type: "freeocs:api",
          path: data.path,
          method: data.method || "POST",
          body: data.body || {},
          pageUrl: location.href,
          pageTitle: document.title,
        })
        .then((response) => respond(data.id, response))
        .catch((error) => respond(data.id, { ok: false, error: String(error && error.message ? error.message : error) }));
    } else if (data.type === "freeocs:log") {
      sendLog(data.level, data.message);
    }
  });

  function injectAgent(agent) {
    const key = `${agent.package}/${agent.id}`;
    if (document.documentElement.dataset[`freeocsAgent${agent.package}${agent.id}`]) return;
    if (!agent.bundle_url) {
      sendLog("warn", `页面 Agent 缺少 bundle_url：${key}`);
      return;
    }
    const script = document.createElement("script");
    script.src = agent.bundle_url;
    script.async = false;
    script.dataset.freeocsAgent = key;
    script.onload = () => {
      document.documentElement.dataset[`freeocsAgent${agent.package}${agent.id}`] = "1";
      sendLog("info", `页面 Agent 已注入：${key}`);
    };
    script.onerror = () => {
      sendLog("error", `页面 Agent 脚本被阻止或加载失败：${key}`);
    };
    (document.head || document.documentElement).appendChild(script);
  }

  async function initAgents() {
    if (!/^https?:/i.test(location.href)) return;
    try {
      const response = await ext.runtime.sendMessage({
        type: "freeocs:get-agents",
        url: location.href,
        token: AGENT_TOKEN,
      });
      if (!response || !Array.isArray(response.agents)) return;
      for (const agent of response.agents) injectAgent(agent);
    } catch (error) {
      console.warn("[FreeOCS] cannot load agents", error);
    }
  }

  ext.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== "object") return false;
    if (message.type === "freeocs:dom") {
      const method = message.method;
      const fn = actions[method];
      if (!fn) {
        sendResponse({ error: `未知方法：${method}` });
        return false;
      }
      Promise.resolve()
        .then(() => fn(...(message.args || [])))
        .then((result) => sendResponse({ result }))
        .catch((error) => sendResponse({ error: String(error && error.message ? error.message : error) }));
      return true;
    }
    return false;
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAgents, { once: true });
  } else {
    initAgents();
  }
})();
