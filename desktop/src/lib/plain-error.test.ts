import { afterEach, describe, expect, it } from "vitest";
import { isTechnicalError, plainErrorLine, productGatewayLine } from "./plain-error";
import { setLocale } from "./i18n";
import { registrySaveFailure } from "../../../packages/shared/registry-save-failure";
import { requestTooLargeMessage } from "../../../packages/shared/request-too-large";
import { PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE } from "../../../packages/shared/product-account";

describe("plainErrorLine", () => {
  it.each([
    ["The operation was aborted due to timeout", "That took too long. Try again."],
    ["502 Bad Gateway", "Something went wrong on the other end. Try again."],
    ["500 Internal Server Error", "Something went wrong on the other end. Try again."],
    ["404 Not Found", "That couldn't be found. It may have been removed."],
    ["413 Payload Too Large", "That's too large to send. Try a smaller file or a shorter message."],
    ["429 Too Many Requests", "Too many requests right now. Wait a moment, then try again."],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', "The service is busy right now. Try again in a moment."],
    ["API Error: 529 Overloaded. This is a server-side issue, usually temporary.", "Overloaded. This is a server-side issue, usually temporary."],
    ["API Error: 400 Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required.", "Claude Code 2.1.268 does not support this model; version 2.1.280 or newer is required."],
    ["OpenRouter HTTP 404: model qwen-9 not found", "model qwen-9 not found"],
    ["HTTP 503", "The service is busy right now. Try again in a moment."],
    ["HTTP 502 Bad Gateway", "Something went wrong on the other end. Try again."],
    ["upstream HTTP 503 Service Unavailable", "The service is busy right now. Try again in a moment."],
    ["EACCES: permission denied, open '/Users/sam/notes.md'", "This computer didn't allow that. Check the file or folder permissions, then try again."],
    ["upstream HTTP 401: {\"error\":{\"message\":\"invalid x-api-key\"}}", "Access was refused. Check the sign-in, then try again."],
    ["read ECONNRESET", "The connection dropped. Try again."],
    ["TypeError: Cannot read properties of undefined (reading 'id')", "Something went wrong. Try again."],
    ["Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON", "Something went wrong. Try again."],
    ["claude exited 3 before result: fake-claude: simulated crash before result", "Something went wrong. Try again."],
    ["claude exited null before result", "Something went wrong. Try again."],
    ["codex exited null (signal SIGKILL) before turn/completed", "Something went wrong. Try again."],
    ["DeepSeek Harness exited 3 before the prompt result: panicked at src/main.rs", "Something went wrong. Try again."],
    ["Antigravity ACP exited SIGTERM.", "Something went wrong. Try again."],
    ["rate_limited", "Too many requests right now. Wait a moment, then try again."],
    ["Error\n    at fetchBots (store.tsx:12:3)", "Something went wrong. Try again."],
  ])("reads %j as a plain line", (raw, line) => {
    expect(plainErrorLine(raw)).toBe(line);
  });

  it.each([
    "Clipboard has no image",
    "Add your key in Settings → API keys",
    "Not logged in · Please run /login",
    "rate limited",
    "Your Pro plan includes 2 cloud computers at once. Delete one to start another.",
    "ChatGPT plan usage limit reached (subscription_sharing_usage_limit_exceeded)",
    "no activity for 10 minutes — the turn was stopped",
    "Muse Code stopped unexpectedly. Send the message again to continue.",
    "The server returned HTTP 503. Wait for the scheduled maintenance to finish, then try again.",
    "Couldn't undo that change.",
    registrySaveFailure("the thread switch", "bots.json", "EPERM"),
    registrySaveFailure("the thread deletion", "groups.json", "ENOSPC"),
    "",
  ])("keeps a sentence a person can read: %j", (raw) => {
    expect(isTechnicalError(raw)).toBe(false);
    expect(plainErrorLine(raw)).toBeUndefined();
  });
});

describe("a provider refusing a message as too large", () => {
  afterEach(() => setLocale("en"));

  it("is said in the reader's language with the model's name", () => {
    const cause = requestTooLargeMessage("GLM 5.3 Flash");
    expect(plainErrorLine(cause)).toBe(cause);
    setLocale("de");
    expect(plainErrorLine(cause)).toBe("Diese Nachricht ist zu groß für GLM 5.3 Flash. Starte einen neuen Chat oder wähle ein Modell, das mehr annimmt.");
    setLocale("ja");
    expect(plainErrorLine(`  ${requestTooLargeMessage("vendor/model-1.5")}\n`)).toBe("このメッセージは vendor/model-1.5 には大きすぎます。新しいチャットを始めるか、より多くを受け付けるモデルを選んでください。");
    expect(plainErrorLine("This message is too large for the box.")).toBeUndefined();
  });
});

describe("an account refusing a request reservation", () => {
  afterEach(() => setLocale("en"));

  it("uses the account balance notice in the reader's language", () => {
    setLocale("en");
    expect(plainErrorLine(PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE)).toBe(PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE);
    setLocale("zh");
    expect(plainErrorLine(`  ${PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE}\n`))
      .toBe("可用点数不足以预留本次请求，请联系管理员");
  });
});

describe("a product account's gateway refusals", () => {
  afterEach(() => setLocale("en"));

  it.each([
    ["upstream HTTP 429: Too many requests are in flight for this account. (ai_busy)", "服务当前繁忙，请稍后再试。本次没有扣除积分。"],
    ["upstream HTTP 503: The AI service is busy. No points were charged. (ai_temporarily_busy)", "服务当前繁忙，请稍后再试。本次没有扣除积分。"],
    ["upstream HTTP 503: The AI service is not available. (ai_unavailable)", "AI 服务暂时不可用，请稍后再试。本次没有扣除积分。"],
    ["upstream HTTP 503: x (ai_temporarily_unavailable)", "AI 服务暂时不可用，请稍后再试。本次没有扣除积分。"],
    ["upstream HTTP 502: The upstream request failed. (upstream_error)", "这条回复没有完成，请重新发送。本次用量正在核对，部分积分暂时冻结，可在账户页查看。"],
    ["provider returned a streaming completion error: The upstream stream failed. (upstream_error)", "这条回复没有完成，请重新发送。本次用量正在核对，部分积分暂时冻结，可在账户页查看。"],
    ["Stream ended before completion", "这条回复没有完成，请重新发送。本次用量正在核对，部分积分暂时冻结，可在账户页查看。"],
    ["upstream HTTP 402: Available points cannot cover another request. (insufficient_balance)", "积分不足，暂时无法发送，请联系管理员充值。"],
    ["upstream HTTP 403: AI access is not enabled. (ai_not_enabled)", "你的账户还没有开通 AI 功能，请联系管理员。"],
    ["upstream HTTP 403: suspended (ai_suspended)", "你的账户还没有开通 AI 功能，请联系管理员。"],
    ["upstream HTTP 401: The AI token is invalid or expired. (ai_token_invalid)", "登录已过期，请重新登录。"],
  ])("reads %j in the person's language", (raw, line) => {
    setLocale("zh");
    expect(productGatewayLine(raw)).toBe(line);
  });

  it("speaks English by default, and leaves any other error to the usual reading", () => {
    expect(productGatewayLine("upstream HTTP 429: x (ai_busy)")).toBe("The service is busy right now. Try again shortly. No points were charged.");
    expect(productGatewayLine("EACCES: permission denied")).toBeUndefined();
  });
});
