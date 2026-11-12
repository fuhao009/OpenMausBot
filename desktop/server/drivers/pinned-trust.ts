// The transport of one parent-pinned account engine: the deployment's own
// public certificate is trusted beside the platform roots, for exactly the
// origin it was bundled with. No environment variable, no process-wide TLS
// setting, and no other origin is reachable through it.
import { createPinnedHttpsFetch } from "../../electron/product-ca.mjs";
import type { RequestTrust } from "../contracts.ts";

/** Undefined without a trust: every other instance keeps the process fetch. */
export function pinnedTransport(trust: RequestTrust | undefined, apiUrl: string): typeof fetch | undefined {
  if (!trust) return undefined;
  let origin: string;
  try {
    origin = new URL(apiUrl).origin;
  } catch {
    throw new Error("The account's AI address is not a URL.");
  }
  if (origin !== trust.origin) {
    throw new Error("The account's AI address is not the origin its certificate was pinned to.");
  }
  try {
    return createPinnedHttpsFetch({ origin: trust.origin, ca: trust.ca }) as typeof fetch;
  } catch {
    throw new Error("The account's pinned certificate could not be verified.");
  }
}
