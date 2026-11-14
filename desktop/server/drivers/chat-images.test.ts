import { describe, expect, it } from "vitest";
import { assertImageTransport, CHAT_IMAGE_BUDGET, chatImageBudget, chatImage, chatToolImageHistory, type ChatContentPart } from "./chat-images.ts";

describe("chat image transport and retained budget", () => {
  it("rejects encoded text and mismatched MIME claims while preserving a PNG", () => {
    const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jBv0AAAAASUVORK5CYII=";
    expect(chatImage({ mimeType: "image/png", data }).image_url.url).toBe(`data:image/png;base64,${data}`);
    expect(() => chatImage({ mimeType: "image/jpeg", data })).toThrow("MIME");
    expect(() => chatImage({ mimeType: "image/png", data: Buffer.from("not an image").toString("base64") })).toThrow("MIME");
  });
  it("counts input and successive screenshot batches against one budget", () => {
    const retain = chatImageBudget();
    const part = { type: "image_url" as const, image_url: { url: "x".repeat(CHAT_IMAGE_BUDGET / 2) } };
    retain([part]);
    retain("ordinary text");
    retain([part]);
    expect(() => retain([{ type: "image_url", image_url: { url: "x" } }])).toThrow("cannot be retained");
    expect(() => chatImageBudget()([part])).not.toThrow();
  });
  it("reclaims evicted bytes only after accepting a replacement and preserves user attachments", () => {
    const retain = chatImageBudget();
    const history = chatToolImageHistory(retain);
    const attachment: ChatContentPart[] = [{ type: "image_url", image_url: { url: "u".repeat(CHAT_IMAGE_BUDGET / 4) } }];
    const first: ChatContentPart[] = [], second: ChatContentPart[] = [], third: ChatContentPart[] = [];
    const screenshot: ChatContentPart = { type: "image_url", image_url: { url: "s".repeat(CHAT_IMAGE_BUDGET / 4) } };
    retain(attachment);
    history(first, [screenshot]);
    history(second, [screenshot]);
    expect(() => history(third, [{ type: "image_url", image_url: { url: "x".repeat(CHAT_IMAGE_BUDGET) } }])).toThrow("cannot be retained");
    expect(first).toEqual([screenshot]);
    expect(second).toEqual([screenshot]);
    expect(third).toEqual([]);
    history(third, [screenshot]);
    expect(first).toEqual([{ type: "text", text: expect.stringContaining("Older tool screenshot omitted") }]);
    expect(second).toEqual([screenshot]);
    expect(third).toEqual([screenshot]);
    expect(attachment[0].type).toBe("image_url");
    for (let index = 0; index < 5; index++) history([], [screenshot]);
    expect(() => retain([{ type: "image_url", image_url: { url: "f".repeat(CHAT_IMAGE_BUDGET / 4) } }])).not.toThrow();
    expect(() => retain([{ type: "image_url", image_url: { url: "x" } }])).toThrow("cannot be retained");
  });
  it("treats all screenshots from one tool round as one batch", () => {
    const history = chatToolImageHistory(chatImageBudget());
    const first: ChatContentPart[] = [], second: ChatContentPart[] = [], third: ChatContentPart[] = [];
    const image: ChatContentPart = { type: "image_url", image_url: { url: "image" } };
    history(first, [image]);
    history(first, [image]);
    history(second, [image]);
    expect(first).toEqual([image, image]);
    history(third, [image]);
    expect(first.every(part => part.type === "text")).toBe(true);
    expect(second).toEqual([image]);
  });
  it.each(["https://api.example.com/v1", "http://localhost:8000/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"])("allows encrypted or loopback transport: %s", url => {
    expect(() => assertImageTransport(url)).not.toThrow();
  });
  it.each(["http://api.example.com/v1", "http://localhost.example.com/v1", "http://192.168.1.4/v1", "ftp://localhost/v1"])("refuses remote cleartext or unsupported transport: %s", url => {
    expect(() => assertImageTransport(url)).toThrow("require HTTPS");
  });
});
