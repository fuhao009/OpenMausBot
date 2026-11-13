import { afterEach, describe, expect, it, vi } from "vitest";
import { reportRequestTokens, requestTokenBreakdown } from "./request-token-diagnostics.ts";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("serialized request token diagnostics", () => {
  it.each(["chat", "responses"])("accounts for every byte of %s without revealing content", protocol => {
    const tool = protocol === "chat" ? { type: "function", function: { name: "clock", description: "PRIVATE TOOL", parameters: {} } }
      : { type: "function", name: "clock", description: "PRIVATE TOOL", parameters: {} };
    const payload = JSON.stringify({ model: "test", ...(protocol === "chat"
      ? { messages: [{ role: "system", content: "PRIVATE SYSTEM" }, { role: "user", content: "PRIVATE INPUT 中文" }] }
      : { instructions: "PRIVATE SYSTEM", input: [{ role: "user", content: "PRIVATE INPUT 中文" }] }), tools: [tool], billing: { maxMicroPoints: 50 } });
    const report = requestTokenBreakdown(payload);
    expect(report.sections.reduce((sum, part) => sum + part.bytes, 0)).toBe(Buffer.byteLength(payload));
    expect(report.sections.find(part => part.id === "tool.0.clock")?.bytes).toBe(Buffer.byteLength(JSON.stringify(tool)));
    expect(report.sections.some(part => part.id.startsWith("system."))).toBe(true);
    expect(report.sections.some(part => part.id === "history")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("PRIVATE");
  });
  it("logs only inference dispatches when explicitly enabled, never headers or payload text", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    const init = { body: JSON.stringify({ input: "SECRET PROMPT" }), headers: { authorization: "Bearer SECRET TOKEN" } };
    vi.stubEnv("OMB_REQUEST_TOKEN_DIAGNOSTICS", "0");
    reportRequestTokens("https://fixture.invalid/responses", init);
    expect(log).not.toHaveBeenCalled();
    vi.stubEnv("OMB_REQUEST_TOKEN_DIAGNOSTICS", "1");
    reportRequestTokens("https://fixture.invalid/quote", init);
    expect(log).not.toHaveBeenCalled();
    reportRequestTokens("https://fixture.invalid/responses", init);
    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(log.mock.calls)).not.toContain("SECRET");
  });
});
