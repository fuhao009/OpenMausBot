import { describe, expect, it } from "vitest";

import { parseArgs, productOrigin, UsageError } from "./package-product.mjs";

const origin = (url, options) => productOrigin({ OMB_PRODUCT_SERVICE_URL: url }, options);

describe("the product package flags", () => {
  it("--lan-origin needs --gateway-ca, like --local-origin", () => {
    expect(() => parseArgs(["--platform", "mac", "--lan-origin"])).toThrow(/--lan-origin needs --gateway-ca/);
    expect(parseArgs(["--platform", "mac", "--lan-origin", "--gateway-ca", "gateway-cert.pem"])).toMatchObject({ lanOrigin: true, gatewayCa: "gateway-cert.pem" });
    expect(() => parseArgs(["--platform", "mac", "--local-origin"])).toThrow(/--local-origin needs --gateway-ca/);
  });

  it("takes a private-network IPv4 origin only with the flag", () => {
    expect(origin("https://192.168.66.193:18487", { lanOrigin: true })).toBe("https://192.168.66.193:18487");
    expect(() => origin("https://192.168.66.193:18487")).toThrow(UsageError);
    expect(() => origin("https://192.168.66.193:18487")).toThrow(/--lan-origin/);
  });

  it("refuses a public IP address even with the flag", () => {
    expect(() => origin("https://8.8.8.8:18487", { lanOrigin: true })).toThrow(/public DNS host/);
  });

  it("leaves the public-host rules unchanged", () => {
    expect(origin("https://ai.acme-ai.net")).toBe("https://ai.acme-ai.net");
    expect(() => origin("https://ai.acme-ai.net:18487")).toThrow(/default HTTPS port/);
    expect(() => origin("https://127.0.0.1:18487", { lanOrigin: true })).toThrow(/loopback/);
  });
});
