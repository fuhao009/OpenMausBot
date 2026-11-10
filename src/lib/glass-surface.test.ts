import { describe, expect, it } from "vitest";
import { glassPopupTopInset } from "./glass-popup";

describe("glass surface", () => {
  it("keeps pop-ups clear of custom window buttons", () => {
    expect(glassPopupTopInset("mac-inset")).toBe(56);
    expect(glassPopupTopInset("win-caption")).toBe(56);
    expect(glassPopupTopInset("native")).toBe(24);
  });

});
