// Chrome DevTools Protocol client for the verification app's real windows.
// Only loopback endpoints are ever contacted, and every helper evaluates in the
// page the target actually is: nothing here reaches into Electron's main
// process or fakes a page response.
import WebSocket from "ws";

/** Only this app's own local documents: a packaged file page, or its loopback server page. */
const LOCAL_DOCUMENT = /^(?:file:\/\/\/|http:\/\/(?:127\.0\.0\.1|localhost):\d+\/)/;
const COMMAND_TIMEOUT_MS = 60_000;

export function debuggerOrigin(port) {
  return `http://127.0.0.1:${port}`;
}

export async function waitForDebugger(port, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${debuggerOrigin(port)}/json/version`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return await response.json();
    } catch (error) { lastError = error; }
    await new Promise(resolve => setTimeout(resolve, 120));
  }
  throw new Error(`the app's debugger never answered${lastError ? `: ${lastError?.message ?? lastError}` : ""}`);
}

export async function listPages(port) {
  const response = await fetch(`${debuggerOrigin(port)}/json/list`, { signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error(`debugger list failed (${response.status})`);
  return (await response.json()).filter(target => target.type === "page" && !target.url.startsWith("devtools://"));
}

/** Waits for a page whose URL matches `pattern`; the newest matching page wins. */
export async function waitForPage(port, pattern, { timeoutMs = 120_000, description = "page" } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const page of await listPages(port).catch(() => [])) {
      if (pattern.test(page.url)) return page;
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const seen = (await listPages(port).catch(() => [])).map(page => page.url);
  throw new Error(`the ${description} never appeared; debugger pages: ${JSON.stringify(seen)}`);
}

class Connection {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.waiting = new Map();
    this.events = [];
    socket.on("message", data => {
      let message;
      try { message = JSON.parse(String(data)); } catch { return; }
      if (message.id !== undefined) {
        const call = this.waiting.get(message.id);
        if (!call) return;
        this.waiting.delete(message.id);
        if (message.error) call.reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ""}`));
        else call.resolve(message.result);
      } else {
        this.events.push(message);
      }
    });
  }

  /** One protocol call, bounded: a dead socket must not look like a hung page. */
  send(method, params = {}, timeoutMs = COMMAND_TIMEOUT_MS) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`${method} did not answer in ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      timer.unref?.();
      const settle = (done, value) => {
        clearTimeout(timer);
        done(value);
      };
      this.waiting.set(id, { resolve: value => settle(resolve, value), reject: error => settle(reject, error) });
      this.socket.send(JSON.stringify({ id, method, params }), error => {
        if (!error) return;
        this.waiting.delete(id);
        settle(reject, error);
      });
    });
  }

  close() {
    try { this.socket.close(); } catch { /* already gone */ }
  }
}

/** One attached page. `evaluate` behaves like the app's own renderer: awaited
 * promises resolve, and thrown values reject here. */
export async function attachPage(target) {
  if (!LOCAL_DOCUMENT.test(target.url)) throw new Error(`refusing a non-local page: ${target.url}`);
  const socket = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false, handshakeTimeout: 20_000 });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const connection = new Connection(socket);
  await connection.send("Page.enable");
  await connection.send("Runtime.enable");

  const evaluate = async (expression) => {
    const result = await connection.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description
        ?? result.exceptionDetails.text
        ?? "page evaluation failed";
      throw new Error(detail.split("\n")[0]);
    }
    return result.result?.value;
  };

  return {
    target,
    connection,
    evaluate,
    /** Waits for a value expression (promises are awaited, unlike `until`,
     * whose Boolean() wrapper would make any promise truthy). */
    async untilValue(expression, { timeoutMs = 60_000, label = expression } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          const value = await evaluate(expression);
          if (value) return value;
        } catch (error) { last = error; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const sample = await evaluate("(document.body?.innerText ?? '').slice(0, 400)").catch(() => "");
      throw new Error(`${label} never held${last ? ` (${last.message})` : ""}; page text: ${JSON.stringify(sample)}`);
    },
    async until(condition, { timeoutMs = 60_000, label = condition } = {}) {
      const deadline = Date.now() + timeoutMs;
      let last;
      while (Date.now() < deadline) {
        try {
          if (await evaluate(`Boolean(${condition})`)) return true;
        } catch (error) { last = error; }
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      const sample = await evaluate("(document.body?.innerText ?? '').slice(0, 400)").catch(() => "");
      throw new Error(`${label} never held${last ? ` (${last.message})` : ""}; page text: ${JSON.stringify(sample)}`);
    },
    async text() {
      return await evaluate("(document.body?.innerText ?? '')");
    },
    async click(description, finder) {
      const clicked = await evaluate(`(() => {
        const element = (${finder});
        if (typeof element === "boolean") return element;
        if (!element) return false;
        element.scrollIntoView({ block: "center" });
        element.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`could not find ${description}`);
    },
    async setViewport(width, height) {
      await connection.send("Emulation.setDeviceMetricsOverride", {
        width, height, deviceScaleFactor: 1, mobile: false,
        screenWidth: width, screenHeight: height,
      });
      await evaluate(`new Promise(resolve => { if (innerWidth === ${width} && innerHeight === ${height}) return resolve(true);
        const end = Date.now() + 4000;
        const tick = () => innerWidth === ${width} && innerHeight === ${height} ? resolve(true)
          : Date.now() > end ? resolve(false) : requestAnimationFrame(tick);
        tick(); })`);
    },
    async screenshot() {
      const { data } = await connection.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      return Buffer.from(data, "base64");
    },
    close() { connection.close(); },
  };
}

/** A page helper that fills a React-controlled field the way typing would. */
export const fillField = (selector, value) => `(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) return false;
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, ${JSON.stringify(value)});
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
  return true;
})()`;

/** Clicks a button by its trimmed accessible text, optionally within `within`. */
export const clickButtonByText = (text, within = "document") => `(() => {
  const scope = ${within};
  const button = [...scope.querySelectorAll("button")].find(candidate =>
    (candidate.getAttribute("aria-label") ?? candidate.textContent ?? "").trim() === ${JSON.stringify(text)});
  if (!button) return false;
  button.scrollIntoView({ block: "center" });
  button.click();
  return true;
})()`;
