import { promptTokenBreakdown } from "../prompt-token-breakdown.ts";

export const REQUEST_TOKEN_DIAGNOSTICS_ENV = "OMB_REQUEST_TOKEN_DIAGNOSTICS";

export function requestTokenBreakdown(payload: string) {
  const request = JSON.parse(payload) as Record<string, unknown>;
  const sections: { id: string; text: string }[] = [];
  const history: unknown[] = [];
  const messages = Array.isArray(request.messages) ? request.messages : Array.isArray(request.input) ? request.input : [];
  if (request.instructions !== undefined) sections.push({ id: "system.instructions", text: JSON.stringify(request.instructions) });
  let system = 0;
  for (const message of messages) {
    if (message && typeof message === "object" && "role" in message && message.role === "system") {
      sections.push({ id: `system.${++system}`, text: JSON.stringify(message) });
    } else history.push(message);
  }
  if (typeof request.input === "string") history.push(request.input);
  if (history.length) sections.push({ id: "history", text: history.map(value => JSON.stringify(value)).join("") });
  if (Array.isArray(request.tools)) request.tools.forEach((tool, index) => {
    const name = tool?.function?.name ?? tool?.name;
    sections.push({ id: `tool.${index}.${typeof name === "string" ? name : "unnamed"}`, text: JSON.stringify(tool) });
  });
  const breakdown = promptTokenBreakdown(sections);
  const bytes = Buffer.byteLength(payload, "utf8");
  const framingBytes = bytes - breakdown.sections.reduce((sum, section) => sum + section.bytes, 0);
  return {
    ...breakdown,
    sections: [...breakdown.sections, { id: "framing_and_parameters", bytes: framingBytes, approxTokens: Math.ceil(framingBytes / 4) }],
    total: { bytes, approxTokens: Math.ceil(bytes / 4) },
    estimate: "UTF-8 bytes / 4, not tokenizer usage. System entries include their JSON wrappers; history includes input and tool results; framing includes JSON separators, model, billing and other parameters. Gateway usage is authoritative.",
  };
}

export function reportRequestTokens(url: string, init: RequestInit) {
  if (process.env[REQUEST_TOKEN_DIAGNOSTICS_ENV] !== "1" || !/\/(responses|chat\/completions)$/.test(url) || typeof init.body !== "string") return;
  console.info("[request-token-diagnostics]", JSON.stringify(requestTokenBreakdown(init.body)));
}
