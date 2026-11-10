import { describe, expect, it } from "vitest";
import { DEFAULT_MAC_ARCHES, resolveCuaMacArches } from "./cua-mac-arches.mjs";

describe("resolveCuaMacArches", () => {
  it("defaults to both packaging targets", () => {
    expect(resolveCuaMacArches({})).toEqual(DEFAULT_MAC_ARCHES);
  });

  it("rejects an empty override even when PARTIAL=1", () => {
    expect(() => resolveCuaMacArches({ HEZUO_CUA_ARCHES: "", HEZUO_CUA_ARCHES_PARTIAL: "1" })).toThrow(
      /HEZUO_CUA_ARCHES is empty/,
    );
    expect(() => resolveCuaMacArches({ HEZUO_CUA_ARCHES: " , ", HEZUO_CUA_ARCHES_PARTIAL: "1" })).toThrow(
      /HEZUO_CUA_ARCHES is empty/,
    );
  });

  it("rejects a one-arch override unless PARTIAL=1", () => {
    expect(() => resolveCuaMacArches({ HEZUO_CUA_ARCHES: "arm64" })).toThrow(/omits x64/);
    expect(resolveCuaMacArches({ HEZUO_CUA_ARCHES: "arm64", HEZUO_CUA_ARCHES_PARTIAL: "1" })).toEqual([
      "arm64",
    ]);
  });
});
