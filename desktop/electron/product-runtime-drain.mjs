import { randomUUID } from "node:crypto";

export const SIGN_OUT_DRAIN_MS = 15_000;

export function createProductRuntimeDrain({ setTimer = setTimeout, clearTimer = clearTimeout, newId = randomUUID } = {}) {
  const pending = new Map();
  return {
    async drain(proc) {
      if (!proc) return;
      const { promise, resolve } = Promise.withResolvers();
      const requestId = newId();
      pending.set(requestId, { proc, resolve });
      const timer = setTimer(resolve, SIGN_OUT_DRAIN_MS);
      try {
        proc.postMessage({ type: "hezuo:drain", requestId, timeoutMs: SIGN_OUT_DRAIN_MS });
        await promise;
      } finally {
        clearTimer(timer);
        pending.delete(requestId);
      }
    },
    receive(proc, message) {
      if (message?.type !== "hezuo:drain-result" || typeof message.requestId !== "string") return false;
      const entry = pending.get(message.requestId);
      if (entry?.proc !== proc) return false;
      entry.resolve();
      return true;
    },
  };
}
