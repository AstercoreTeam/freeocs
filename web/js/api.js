/* Thin wrapper around the pywebview js_api. */
(function () {
  "use strict";

  function waitReady() {
    if (window.pywebview && window.pywebview.api) return Promise.resolve();
    return new Promise((resolve) => {
      window.addEventListener("pywebviewready", () => resolve(), { once: true });
    });
  }

  const readyPromise = waitReady();

  async function call(name, ...args) {
    await readyPromise;
    if (!window.pywebview || !window.pywebview.api) {
      throw new Error("pywebview 尚未就绪");
    }
    const fn = window.pywebview.api[name];
    if (typeof fn !== "function") {
      throw new Error(`后端方法不存在：${name}`);
    }
    const result = await fn(...args);
    return result;
  }

  async function must(name, ...args) {
    const result = await call(name, ...args);
    if (!result || result.ok !== true) {
      const error = new Error((result && result.error) || "操作失败");
      error.code = (result && result.code) || "";
      error.result = result;
      throw error;
    }
    return result;
  }

  window.API = { ready: readyPromise, call, must };
})();
