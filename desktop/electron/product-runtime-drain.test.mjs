import { describe, expect, it, vi } from "vitest";
import { createProductRuntimeDrain, SIGN_OUT_DRAIN_MS } from "./product-runtime-drain.mjs";

describe("product runtime drain", () => {
  it("waits for the matching owned runtime acknowledgement before disconnecting", async () => {
    const timers = new Map();
    const proc = { postMessage: vi.fn() };
    const drain = createProductRuntimeDrain({
      newId: () => "drain-1",
      setTimer: (callback, milliseconds) => { timers.set(callback, milliseconds); return callback; },
      clearTimer: callback => timers.delete(callback),
    });
    let disconnected = false;
    const stopping = drain.drain(proc).then(() => { disconnected = true; });
    expect(proc.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "hezuo:drain", requestId: "drain-1", timeoutMs: 15_000 });
    expect(disconnected).toBe(false);
    expect(drain.receive({}, { type: "hezuo:drain-result", requestId: "drain-1" })).toBe(false);
    expect(drain.receive(proc, { type: "hezuo:drain-result", requestId: "other" })).toBe(false);
    expect(disconnected).toBe(false);
    expect(drain.receive(proc, { type: "hezuo:drain-result", requestId: "drain-1" })).toBe(true);
    await stopping;
    expect(disconnected).toBe(true);
    expect(timers.size).toBe(0);
  });

  it("does not disconnect before the 15-second limit, then permits shutdown", async () => {
    vi.useFakeTimers();
    try {
      const proc = { postMessage: vi.fn() };
      const drain = createProductRuntimeDrain();
      let disconnected = false;
      const stopping = drain.drain(proc).then(() => { disconnected = true; });
      await vi.advanceTimersByTimeAsync(SIGN_OUT_DRAIN_MS - 1);
      expect(disconnected).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await stopping;
      expect(disconnected).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("cleans the timer if the owned process has already exited", async () => {
    const clearTimer = vi.fn();
    const drain = createProductRuntimeDrain({ setTimer: () => 1, clearTimer });
    await expect(drain.drain({ postMessage() { throw new Error("exited"); } })).rejects.toThrow("exited");
    expect(clearTimer).toHaveBeenCalledWith(1);
  });
});
