import { describe, expect, it } from "vitest";
import { ComputerUsePermission } from "./computer-use-permission.ts";
import type { ComputerUsePolicy } from "../shared/computer-use-policy.ts";
import { effectiveComputerUsePolicy } from "../shared/computer-use-policy.ts";

function fixture(initial: ComputerUsePolicy = "ask") {
  let policy = initial;
  const asks: { resolve: () => void; reject: (error: Error) => void }[] = [];
  const gate = new ComputerUsePermission(() => policy, () => {
    return new Promise<void>((resolve, reject) => {
      asks.push({ resolve, reject });
    });
  });
  return { gate, asks, set(next: ComputerUsePolicy) { policy = next; gate.changed(); } };
}

describe("workspace computer consent", () => {
  it("defaults to an ask, shares the pending question, and remembers only this turn", async () => {
    const f = fixture();
    f.gate.register("thread", "turn", false);
    const first = f.gate.check("thread", "turn");
    const second = f.gate.check("thread", "turn");
    expect(f.asks).toHaveLength(1);
    f.asks[0]!.resolve();
    await Promise.all([first, second]);
    await f.gate.check("thread", "turn");
    expect(f.asks).toHaveLength(1);
    f.gate.register("thread", "next", false);
    const next = f.gate.check("thread", "next");
    expect(f.asks).toHaveLength(2);
    f.asks[1]!.resolve();
    await next;
  });

  it("allows no repeated screen questions but deny also blocks explicit selection", async () => {
    const f = fixture("allow");
    f.gate.register("thread", "turn", true);
    await f.gate.check("thread", "turn");
    await f.gate.check("thread", "turn");
    expect(f.asks).toHaveLength(0);
    f.set("deny");
    await expect(f.gate.check("thread", "turn")).rejects.toThrow("Never allow");
    f.gate.register("other", "explicit", true);
    await expect(f.gate.check("other", "explicit")).rejects.toThrow("Never allow");
  });

  it("revoking always allow asks on the next gated call, even with a prior explicit selection", async () => {
    const f = fixture("allow");
    f.gate.register("thread", "turn", true);
    await f.gate.check("thread", "turn");
    f.set("ask");
    const check = f.gate.check("thread", "turn");
    expect(f.asks).toHaveLength(1);
    f.asks[0]!.resolve();
    await check;
  });

  it("cannot accept a pending answer after deny or reuse it for a replaced turn", async () => {
    const f = fixture();
    f.gate.register("thread", "turn", false);
    const check = f.gate.check("thread", "turn");
    f.set("deny");
    f.asks[0]!.resolve();
    await expect(check).rejects.toThrow("Never allow");
    f.set("ask");
    const old = f.gate.check("thread", "turn");
    f.gate.register("thread", "new", false);
    f.asks[1]!.resolve();
    await expect(old).rejects.toThrow("ended");
  });

  it("does not transfer consent into another workspace or restarted gate", async () => {
    const old = fixture("allow");
    old.gate.register("thread", "turn", false);
    await old.gate.check("thread", "turn");
    const fresh = fixture();
    fresh.gate.register("thread", "turn", false);
    const check = fresh.gate.check("thread", "turn");
    expect(fresh.asks).toHaveLength(1);
    fresh.asks[0]!.resolve();
    await check;
  });
});

it("restores a choice only on its bound installation, never from a portable workspace alone", () => {
  const stored = JSON.parse(JSON.stringify({ computerUsePolicy: "allow", computerUsePolicyDevice: "device-a" }));
  expect(effectiveComputerUsePolicy(stored, "device-a")).toBe("allow");
  expect(effectiveComputerUsePolicy(stored, "device-b")).toBe("ask");
  expect(effectiveComputerUsePolicy(stored, undefined)).toBe("ask");
  expect(effectiveComputerUsePolicy({}, "device-a")).toBe("ask");
  expect(effectiveComputerUsePolicy({ computerUsePolicy: "allow" }, "device-a")).toBe("ask");
});

it("fails closed when host permission registration is missing, expired, or replaced", async () => {
  const f = fixture("allow");
  await expect(f.gate.check("thread", "turn")).rejects.toThrow("no registered permission");
  f.gate.register("thread", "turn", true);
  await expect(f.gate.check("thread", "stale")).rejects.toThrow("no registered permission");
  f.gate.forget("thread", "turn");
  await expect(f.gate.check("thread", "turn")).rejects.toThrow("no registered permission");
});
