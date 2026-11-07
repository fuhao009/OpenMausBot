// Types for product-ca.mjs: the pinned public certificate of the exact origin
// the product app talks to. Shared by the Electron main process, the runtime's
// provider code and the packaging scripts.
export declare function normalizeProductCa(
  value: unknown,
  options?: { now?: number },
): string | null;
export declare function productCaBindsOrigin(ca: unknown, origin: unknown): boolean;
export declare function normalizeProductTrust(
  value?: { origin?: unknown; ca?: unknown; now?: number },
): { origin: string; ca: string } | null;
export declare function createPinnedHttpsFetch(options: {
  origin: string;
  ca: string;
}): typeof fetch & { close(): void };
