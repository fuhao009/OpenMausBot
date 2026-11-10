import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { accountDeviceId, createAccountAuthenticator, readProductAccountTrust } from "./account-session.ts";

const CA = `-----BEGIN CERTIFICATE-----
MIIB8TCCAXugAwIBAgIUTqG8placeholderAAAAAAAAAAAAAAAAAAAAAwCgYIKoZI
zj0EAwIwEzERMA8GA1UEAwwIZ2F0ZXdheTAeFw0yNjAxMDEwMDAwMDBaFw0yNzAx
MDEwMDAwMDBaMBMxETAPBgNVBAMMCGdhdGV3YXkwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAAAAAAAAAAAAAAAB
-----END CERTIFICATE-----
`;

describe("account device ids", () => {
  it("stays within the companion device id alphabet", () => {
    expect(accountDeviceId("user_alice")).toBe("account-user_alice");
    expect(accountDeviceId("user/../x")).toBe("account-user----x");
  });
});

describe("the product account trust file", () => {
  it("refuses a missing file, a loopback http origin, or a key block", () => {
    expect(readProductAccountTrust(undefined)).toBeNull();
    const dir = mkdtempSync(join(tmpdir(), "omb-trust-"));
    const file = join(dir, "trust.json");
    writeFileSync(file, JSON.stringify({ origin: "http://127.0.0.1:1/", ca: "nope", userId: "u" }));
    expect(readProductAccountTrust(file)).toBeNull();
  });
});

describe("account session authentication", () => {
  it("accepts a live token for the signed-in user and never grants admin extras", async () => {
    const calls: string[] = [];
    const auth = createAccountAuthenticator({
      trust: () => ({ origin: "https://gateway.example.test", ca: "-----BEGIN CERTIFICATE-----\nA\n-----END CERTIFICATE-----\n", userId: "user_1" }),
      fetchMe: async (_trust, token) => {
        calls.push(token);
        if (token === "good") return { status: 200, body: { user: { id: "user_1", email: "a@b.test" } } };
        if (token === "other") return { status: 200, body: { user: { id: "user_2", email: "c@d.test" } } };
        return { status: 401, body: { error: { code: "unauthorized" } } };
      },
    });
    const device = await auth("good");
    expect(device?.id).toBe("account-user_1");
    expect(device?.cloudDesktopAccess).toBe(false);
    expect(device?.browserControlAccess).toBe(false);
    await auth("good");
    expect(calls).toEqual(["good"]);
    expect(await auth("other")).toBeNull();
    expect(await auth("expired")).toBeNull();
  });
});
