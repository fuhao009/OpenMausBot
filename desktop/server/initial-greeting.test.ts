import { describe, expect, it } from "vitest";

import "./server-line-packs.ts";
import { initialGreeting, initialGreetingMessage, setupChoices, setupRequestLine } from "./initial-greeting.ts";

describe("the line after Set me up", () => {
  it("is written in the app's language, by region, with English for any other", () => {
    expect(setupRequestLine("en")).toBe(
      "Great. Tell me what you'd like help with, in your own words, and I'll set myself up for it. For example: \"sort my inbox every morning\" or \"research our competitors every week\".",
    );
    expect(setupRequestLine("es-MX")).toMatch(/^Genial\. Cuéntame/);
    expect(setupRequestLine("pt-BR")).toMatch(/^Ótimo\. Me conte/);
    expect(setupRequestLine("fr")).toBe(setupRequestLine("en"));
    expect(setupRequestLine(undefined)).toBe(setupRequestLine("en"));
  });

  it("leaves the greeting itself as it was", () => {
    expect(initialGreeting("Ava", "en")).toBe("Hi, I'm Ava. What would you like me to do?");
  });
});

describe("a new bot's greeting", () => {
  it("names the person by their first name, in the app's language", () => {
    expect(initialGreeting("Scout", "en", "Milind Soni")).toBe("Hi Milind, I'm Scout. What would you like me to do?");
    expect(initialGreeting("Scout", "es-MX", "  Ana  María ")).toBe("Hola Ana, soy Scout. ¿Qué te gustaría que hiciera?");
    expect(initialGreeting("Scout", "pt-BR", "João")).toBe("Oi João, eu sou Scout. O que você gostaria que eu fizesse?");
  });

  it("names no one when the person has not given a name", () => {
    for (const person of [undefined, "", "   "]) {
      expect(initialGreeting("Scout", "en", person)).toBe("Hi, I'm Scout. What would you like me to do?");
    }
  });

  it.each([
    ["zh-CN", "你好，我是 Scout。你想让我做什么？", "研究和深入了解主题"],
    ["zh-Hant", "你好，我是 Scout。你想讓我做什麼？", "研究和深入了解主題"],
    ["en-US", "Hi, I'm Scout. What would you like me to do?", "Research and digging into topics"],
    ["ko-KR", "안녕하세요. 저는 Scout입니다. 무엇을 도와드릴까요?", "리서치와 주제 깊이 파고들기"],
  ])("seeds local greeting and setup choices in %s", (language, text, choice) => {
    const message = initialGreetingMessage("Scout", () => language, true);
    expect(message).toMatchObject({ text, setupOffer: true, setupChoices: setupChoices(language) });
    expect(message.setupChoices?.[0]).toBe(choice);
    if (language !== "en-US") expect(setupRequestLine(language)).not.toBe(setupRequestLine("fr"));
  });
});
