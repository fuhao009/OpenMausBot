import { describe, expect, it } from "vitest";

import { defaultSentinelOut, isInside } from "./paths.ts";

describe("sentinel paths", () => {
  it("keeps Sentinel's files in the platform's state folder, outside the data dir", () => {
    expect(defaultSentinelOut("/Users/hezuo/.hezuo", "darwin", "/Users/hezuo", {})).toBe("/Users/hezuo/Library/Application Support/hezuo-sentinel");
    expect(defaultSentinelOut("/home/hezuo/.hezuo", "linux", "/home/hezuo", {})).toBe("/home/hezuo/.local/state/hezuo-sentinel");
    expect(defaultSentinelOut("/home/hezuo/.hezuo", "linux", "/home/hezuo", { XDG_STATE_HOME: "/var/state/hezuo" })).toBe("/var/state/hezuo/hezuo-sentinel");
    // a relative XDG_STATE_HOME is invalid by the spec and ignored
    expect(defaultSentinelOut("/home/hezuo/.hezuo", "linux", "/home/hezuo", { XDG_STATE_HOME: "state" })).toBe("/home/hezuo/.local/state/hezuo-sentinel");
    expect(defaultSentinelOut("C:\\Users\\hezuo\\.hezuo", "win32", "C:\\Users\\hezuo", { LOCALAPPDATA: "D:\\Local" })).toBe("D:\\Local\\hezuo-sentinel");
  });

  it("gives any other data dir its own subfolder, the same one every time", () => {
    const other = defaultSentinelOut("/srv/omb-data", "linux", "/home/hezuo", {});
    expect(other).toMatch(/^\/home\/hezuo\/\.local\/state\/hezuo-sentinel\/data-[0-9a-f]{12}$/);
    expect(defaultSentinelOut("/srv/omb-data", "linux", "/home/hezuo", {})).toBe(other);
    expect(defaultSentinelOut("/srv/omb-data-2", "linux", "/home/hezuo", {})).not.toBe(other);
  });

  it("knows when a folder is inside another", () => {
    expect(isInside("/d/omb/sentinel", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb", "/d/omb", "linux")).toBe(true);
    expect(isInside("/d/omb-sentinel", "/d/omb", "linux")).toBe(false);
    expect(isInside("/d", "/d/omb", "linux")).toBe(false);
    expect(isInside("C:\\d\\omb\\x", "C:\\d\\omb", "win32")).toBe(true);
  });
});
