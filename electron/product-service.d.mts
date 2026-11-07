export interface ProductService {
  origin: string;
  /** The pinned public certificate of exactly this origin, or null when the
   * operating system's trust store is the only anchor (resource v1). */
  ca: string | null;
  managed: true;
}

export function validateProductOrigin(value: unknown, options?: { allowLoopback?: boolean }): string;
export function resolveProductService(options: {
  isPackaged: boolean;
  appPath?: string;
  resourcesPath?: string;
  environment?: Record<string, string | undefined>;
  fixtureOrigin?: string;
}): Promise<ProductService | null>;
