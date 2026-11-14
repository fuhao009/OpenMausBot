import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddedBrowserBackend, type EmbeddedBrowserBackend } from "./embedded-backend.ts";
import { FakeChrome } from "./testing/fake-chrome.ts";

const request = { key: "bot:embedded", mode: "headless" as const, fresh: false, viewport: { width: 1280, height: 800 }, downloadDir: "/tmp/embedded-downloads" };
afterEach(() => vi.useRealTimers());

describe("embedded browser leases", () => {
  it("requires the configured egress gate and releases late open results", async () => {
    vi.useFakeTimers();
    const sent: Record<string, unknown>[] = [];
    const backend = createEmbeddedBrowserBackend({ send: (message) => { sent.push(message); }, egressPort: async () => 1234 });
    const opening = backend.open(request);
    const rejected = expect(opening).rejects.toThrow("did not open in time");
    await vi.advanceTimersByTimeAsync(20_000);
    await rejected;
    expect(sent[0]).toMatchObject({ type: "hezuo:embedded-browser-open", profileKey: request.key, egressPort: 1234 });
    backend.receive({ type: "hezuo:embedded-browser-open-result", requestId: sent[0]!.requestId, ok: true, leaseId: "late", generation: "g", version: "123", pageLimit: null });
    expect(sent.at(-1)).toEqual({ type: "hezuo:embedded-browser-release", leaseId: "late", generation: "g" });
    backend.close();
  });

  it("rejects missing egress and cancels a pending open on shutdown", async () => {
    const sent: unknown[] = [];
    const unavailable = createEmbeddedBrowserBackend({ send: (message) => { sent.push(message); }, egressPort: async () => 0 });
    await expect(unavailable.open(request)).rejects.toThrow("egress gate");
    expect(sent).toEqual([]);
    const backend = createEmbeddedBrowserBackend({ send: (message) => { sent.push(message); }, egressPort: async () => 1234 });
    const opening = backend.open(request);
    backend.close();
    await expect(opening).rejects.toThrow("link closed while opening");
    await expect(backend.open(request)).rejects.toThrow("link is closed");
  });

  it("initializes CDP only on its lease and ignores another generation's close", async () => {
    const chrome = new FakeChrome();
    let backend: EmbeddedBrowserBackend;
    const sent: Record<string, unknown>[] = [];
    backend = createEmbeddedBrowserBackend({ egressPort: async () => 1234, send(message) {
      sent.push(message);
      if (message.type === "hezuo:embedded-browser-open") queueMicrotask(() => backend.receive({ type: "hezuo:embedded-browser-open-result", requestId: message.requestId, ok: true, leaseId: "owned", generation: "current", version: "123", pageLimit: null }));
      if (message.type === "hezuo:embedded-browser-cdp") chrome.send(String(message.message));
    } });
    chrome.onMessage((message) => backend.receive({ type: "hezuo:embedded-browser-cdp", leaseId: "owned", generation: "current", message }));
    const opened = await backend.open(request);
    expect(opened.browser.setup.focusEmulation).toBe(false);
    expect(opened.browser.viewport).toBeNull();
    backend.receive({ type: "hezuo:embedded-browser-closed", leaseId: "owned", generation: "stale", reason: "wrong" });
    expect(opened.browser.connected).toBe(true);
    let finished = false;
    const closing = opened.close().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    backend.receive({ type: "hezuo:embedded-browser-closed", leaseId: "owned", generation: "stale", reason: "wrong" });
    await Promise.resolve();
    expect(finished).toBe(false);
    backend.receive({ type: "hezuo:embedded-browser-closed", leaseId: "owned", generation: "current", reason: "released" });
    await closing;
    await opened.exited;
    expect(sent.at(-1)).toEqual({ type: "hezuo:embedded-browser-release", leaseId: "owned", generation: "current" });
    backend.close();
  });
});
