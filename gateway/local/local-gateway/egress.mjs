// Only upstream headers cross the Worker boundary; platform metadata must not leak.
const EGRESS_HEADERS = ["accept", "accept-encoding", "authorization", "content-type"];
const safeCode = value => typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(value) ? value : undefined;

export function egressFailureCodes(error) {
  const codes = new Set();
  const seen = new Set();
  const visit = (value, depth) => {
    if (!value || typeof value !== "object" || seen.has(value) || depth > 4) return;
    seen.add(value);
    const code = safeCode(value.code);
    if (code) codes.add(code);
    visit(value.cause, depth + 1);
    if (Array.isArray(value.errors)) for (const child of value.errors.slice(0, 8)) visit(child, depth + 1);
  };
  visit(error, 0);
  return [...codes];
}

export async function directEgress(request, { fetchImpl = fetch, log = console.error, now = Date.now, trace = process.env.OMB_LOCAL_GATEWAY_DEBUG_EGRESS === "1" } = {}) {
  const started = now();
  const target = new URL(request.url);
  let bytes = 0;
  try {
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
    bytes = body?.byteLength ?? 0;
    const headers = new Headers();
    for (const name of EGRESS_HEADERS) {
      const value = request.headers.get(name);
      if (value !== null) headers.set(name, value);
    }
    if (trace) log(`[local-gateway] egress ${request.method} ${target.origin} ${bytes}B`);
    const response = await fetchImpl(request.url, { method: request.method, headers, body, redirect: "manual" });
    if (trace) log(`[local-gateway] egress reply ${response.status}`);
    return response;
  } catch (error) {
    log(`[local-gateway] egress failed ${JSON.stringify({ host: target.host, method: request.method, bytes, elapsedMs: now() - started, codes: egressFailureCodes(error) })}`);
    return new Response(JSON.stringify({ error: "egress_failed" }), { status: 502, headers: { "content-type": "application/json" } });
  }
}
