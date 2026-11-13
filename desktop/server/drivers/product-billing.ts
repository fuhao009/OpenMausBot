import type { RequestCredential } from "../contracts.ts";

export const MAX_TURN_POINTS = 50;
export const turnBudget = (available: number, confirmed = false) => Math.min(available, confirmed ? available : MAX_TURN_POINTS * 1_000_000);
export const balanceFailure = (available: number) => `product_insufficient_balance:${available}`;

export async function billedFetch(send: (url: string, init: RequestInit) => Promise<Response>, url: string, init: RequestInit, credential: RequestCredential,
  confirm?: () => Promise<boolean>): Promise<Response> {
  let renewed = false;
  let confirmed = false;
  let fallback = false;
  for (;;) {
    const current = credential();
    const billing = current.billing;
    if (!billing) return send(url, init);
    const request = JSON.parse(String(init.body)) as Record<string, unknown>;
    if (billing.availableMicroPoints <= 0) throw new Error(balanceFailure(billing.availableMicroPoints));
    request.billing = { maxMicroPoints: turnBudget(billing.availableMicroPoints, confirmed) };
    const endpoint = url.endsWith("/responses") ? "responses" : "chat";
    const fallbackModel = typeof request.model === "string" && !request.model.startsWith("auto-") ? request.model
      : billing.fallbackModels?.find(model => model.protocol === endpoint)?.id;
    if (fallback && fallbackModel) request.model = fallbackModel;
    const headers = { ...init.headers, authorization: `Bearer ${current.apiKey}` };
    const requestInit = { ...init, headers, body: JSON.stringify(request) };
    const quote = fallback || !billing.quoteProtocols?.includes(endpoint) ? null : await send(url.replace(/\/(responses|chat\/completions)$/, "/quote"), {
      ...requestInit, body: JSON.stringify({ endpoint, request }),
    });
    let response: Response;
    if (quote === null || quote.ok) {
      await quote?.body?.cancel();
      response = await send(url, requestInit);
    } else response = quote;
    if (response.ok) return response;
    let code: string | undefined;
    try {
      const body = await response.clone().json() as { error?: string | { code?: string } };
      code = typeof body.error === "string" ? body.error : body.error?.code;
    } catch { /* A non-JSON gateway failure still belongs to the caller. */ }
    if (response.status === 401 && code === "ai_token_invalid" && !renewed && billing.renewToken) {
      renewed = true;
      await response.body?.cancel();
      if (await billing.renewToken()) continue;
      throw new Error("product_ai_session_expired");
    }
    if (response.status === 401 && code === "ai_token_invalid") throw new Error("product_ai_session_expired");
    if (response === quote && response.status === 503 && code === "dynamic_billing_disabled" && !fallback && fallbackModel) {
      fallback = true;
      await response.body?.cancel();
      continue;
    }
    if (response.status === 402 && code === "budget_exceeded" && !confirmed && confirm) {
      await response.body?.cancel();
      if (await confirm()) { confirmed = true; continue; }
      throw new Error(`product_budget_exceeded:${MAX_TURN_POINTS}`);
    }
    if (response.status === 402 && code === "insufficient_balance") throw new Error(balanceFailure(billing.availableMicroPoints));
    return response;
  }
}
