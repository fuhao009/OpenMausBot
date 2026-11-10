// The deploy script's verification toggle: a deployment with a sender confirms
// new password accounts by emailed code, and one deliberately without mail needs
// no sender at all. Both fail closed on a half-configured pair.
import { expect, it } from "vitest";

import { productWorkerConfig, readProductDeployment } from "./deploy-product-service.mjs";

const BASE = {
  CLOUDFLARE_ACCOUNT_ID: "0".repeat(32),
  OMB_PRODUCT_SERVICE_URL: "https://ai.acme-ai.net",
  OMB_PRODUCT_D1_ID: "00000000-0000-4000-8000-000000000000",
  BETTER_AUTH_SECRET: "x".repeat(40),
};
const COMPAT = { compatibility_date: "2026-08-25" };

it("a deployment with a sender requires emailed verification and binds email", () => {
  const deployment = readProductDeployment({ ...BASE, EMAIL_FROM: "noreply@acme-ai.net" }, { realDeploy: true });
  expect(deployment.emailVerification).toBe("required");
  expect(deployment.vars.AUTH_EMAIL_VERIFICATION).toBe("required");
  expect(deployment.vars.EMAIL_FROM).toBe("noreply@acme-ai.net");
  const config = productWorkerConfig(deployment, COMPAT);
  expect(config.send_email).toEqual([{
    name: "EMAIL",
    allowed_sender_addresses: ["noreply@acme-ai.net"],
  }]);
});

it("AUTH_EMAIL_VERIFICATION=off deploys password accounts with no mail or sender binding", () => {
  const deployment = readProductDeployment({ ...BASE, AUTH_EMAIL_VERIFICATION: "off" }, { realDeploy: true });
  expect(deployment.emailVerification).toBe("off");
  expect(deployment.emailFrom).toBeNull();
  expect(deployment.vars.AUTH_EMAIL_VERIFICATION).toBe("off");
  expect("EMAIL_FROM" in deployment.vars).toBe(false);
  expect(productWorkerConfig(deployment, COMPAT).send_email).toBeUndefined();
});

it("requiring mail verification without a sender, or naming an unknown mode, fails", () => {
  expect(() => readProductDeployment({ ...BASE, AUTH_EMAIL_VERIFICATION: "required" }, { realDeploy: true }))
    .toThrow(/EMAIL_FROM is required unless AUTH_EMAIL_VERIFICATION=off/);
  expect(() => readProductDeployment({ ...BASE, EMAIL_FROM: "noreply@acme-ai.net", AUTH_EMAIL_VERIFICATION: "maybe" }, { realDeploy: true }))
    .toThrow(/AUTH_EMAIL_VERIFICATION must be `required` or `off`/);
  // A sender is still validated when it is present.
  expect(() => readProductDeployment({ ...BASE, EMAIL_FROM: "not-an-address" }, { realDeploy: true }))
    .toThrow(/EMAIL_FROM must be a valid email address/);
});
