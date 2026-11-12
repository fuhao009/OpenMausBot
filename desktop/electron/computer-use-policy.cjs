"use strict";

const policies = new Set(["ask", "allow", "deny"]);

/** Requests stay bound to the embedded process, never a loopback HTTP grant. */
function createComputerUsePolicyBridge({ randomId, timeoutMs = 10000 }) {
  return {
    request(proc, policy) {
      if (policy !== undefined && !policies.has(policy)) return Promise.reject(new Error("Invalid computer permission"));
      const requestId = randomId();
      return new Promise((resolve, reject) => {
        const finish = (error, value) => {
          clearTimeout(timer);
          proc.removeListener("message", receive);
          proc.removeListener("exit", exited);
          if (error) reject(error);
          else resolve(value);
        };
        const receive = raw => {
          const message = raw?.data ?? raw;
          if (message?.type !== "computer-use-policy-result" || message.requestId !== requestId) return;
          if (!message.ok || !policies.has(message.policy)) return finish(new Error(message.error || "Computer permission could not be saved"));
          finish(null, message.policy);
        };
        const exited = () => finish(new Error("The workspace changed before computer permission was saved"));
        const timer = setTimeout(() => finish(new Error("Computer permission request timed out")), timeoutMs);
        proc.on("message", receive);
        proc.once("exit", exited);
        try { proc.postMessage({ type: policy === undefined ? "computer-use-policy-get" : "computer-use-policy-set", requestId, ...(policy === undefined ? {} : { policy }) }); }
        catch (error) { finish(error); }
      });
    },
  };
}

module.exports = { createComputerUsePolicyBridge };
