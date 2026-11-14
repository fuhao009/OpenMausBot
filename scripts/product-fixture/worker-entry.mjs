// Fixture-only observation boundary: never rewrite a request or a Worker response.
// Persist field names and coarse outcomes, not prompts, credentials or account data.
import worker from "fixture:worker";

export default {
  ...worker,
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    const inference = path === "/v1/ai/chat/completions" || path === "/v1/ai/responses" || path === "/v1/ai/quote";
    if (!inference) return worker.fetch(request, env, ctx);
    const startedAt = Date.now();
    let fields = [], billingFields = [], malformedJson = false;
    try {
      const body = await request.clone().json();
      if (body && typeof body === "object" && !Array.isArray(body)) {
        fields = Object.keys(body).sort();
        if (body.billing && typeof body.billing === "object" && !Array.isArray(body.billing)) {
          billingFields = Object.keys(body.billing).sort();
        }
      }
    } catch { malformedJson = true; }
    const response = await worker.fetch(request, env, ctx);
    let errorCode = null;
    if (!response.ok) {
      try {
        const body = await response.clone().json();
        const code = typeof body.error === "string" ? body.error : body.error?.code;
        if (typeof code === "string" && /^[a-z_]{1,80}$/.test(code)) errorCode = code;
      } catch { /* A non-JSON error still has its HTTP status. */ }
    }
    try {
      await fetch("https://diagnostics.fixture.test/inference", {
        method: "POST",
        body: JSON.stringify({ path, startedAt, durationMs: Date.now() - startedAt, fields, billingFields, malformedJson, status: response.status, errorCode }),
      });
    } catch { console.error("fixture inference diagnostics unavailable"); }
    return response;
  },
};
