import { describe, expect, it } from "vitest";

import en from "../../desktop/src/locales/en.json";
import {
  cleanAskWhy, COMPUTER_ASK_REASONS, COMPUTER_ASK_WORDS, computerAskReasonLine, computerAskText, needsTheApp, turnsOnFromHere,
} from "./computer-ask.ts";

const line = (reason: (typeof COMPUTER_ASK_REASONS)[number], device: "PC" | "Mac" | "computer") => {
  const { key, params } = computerAskReasonLine({ reason, device }, "Scout");
  return computerAskText(key, params);
};

describe("a bot's ask to turn on what it needs from the person's computer", () => {
  it("renders every reason without unresolved interpolation for each device", () => {
    for (const reason of COMPUTER_ASK_REASONS) {
      for (const device of ["PC", "Mac", "computer"] as const) {
        expect(line(reason, device).trim()).not.toBe("");
        expect(line(reason, device)).not.toMatch(/\{\w+\}/);
      }
    }
  });

  it("offers Turn on only where the app on that computer can do it, and the app itself where it's the fix", () => {
    expect(COMPUTER_ASK_REASONS.filter(turnsOnFromHere)).toEqual(["paused", "permissions", "blocked", "off", "not-running", "terminal-off"]);
    expect(COMPUTER_ASK_REASONS.filter(needsTheApp)).toEqual(["closed", "never", "update"]);
    expect(COMPUTER_ASK_REASONS.filter((reason) => !turnsOnFromHere(reason) && !needsTheApp(reason))).toEqual(["starting", "unsupported"]);
  });

  it("keeps a bot's reason to one clean line on the card", () => {
    expect(cleanAskWhy("  Fill in\nthe invoice‮ in Excel  ")).toBe("Fill in the invoice in Excel");
    expect(cleanAskWhy("x".repeat(300))).toHaveLength(200);
    expect(cleanAskWhy("   ")).toBeUndefined();
    expect(cleanAskWhy(42)).toBeUndefined();
  });

  it("has locale coverage for every reason and action key", () => {
    for (const key of Object.keys(COMPUTER_ASK_WORDS)) expect((en as Record<string, string>)[key], key).toEqual(expect.any(String));
  });
});
