import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  clearProductAccountTrust,
  readProductAccountTrust,
  writeProductAccountTrust,
} from "./product-gateway-host.mjs";

const dirs = [];

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "omb-gateway-host-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("product account trust file", () => {
  it("writes origin, public CA, and user id, and never a bearer token", () => {
    const root = scratch();
    const file = writeProductAccountTrust(root, {
      origin: "https://gateway.example:8787",
      ca: "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n",
      userId: "user-1",
    });
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toMatch(/token|bearer|omb_/i);
    const stored = readProductAccountTrust(file);
    expect(stored.origin).toBe("https://gateway.example:8787");
    expect(stored.userId).toBe("user-1");
    expect(stored.ca).toContain("BEGIN CERTIFICATE");
    expect(stored.ca).toContain("MIIB");
  });

  it("rejects a missing field and can be cleared", () => {
    const root = scratch();
    const file = writeProductAccountTrust(root, {
      origin: "https://gateway.example:8787",
      ca: "CERT",
      userId: "user-1",
    });
    writeFileSync(file, JSON.stringify({ origin: "https://gateway.example:8787", userId: "user-1" }));
    expect(readProductAccountTrust(file)).toBeNull();
    clearProductAccountTrust(root);
    expect(readProductAccountTrust(file)).toBeNull();
  });
});
