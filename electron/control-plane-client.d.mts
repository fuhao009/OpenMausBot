// Types for control-plane-client.mjs as the headless server uses it
// (server/tunnel.ts). Keep in step with the implementation.
export declare class ControlPlaneError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  /** Server-requested delay from a Retry-After header, or 0. */
  readonly retryAfterMs: number;
  constructor(code: string, status?: number, requestId?: string, retryAfterMs?: number);
}

export declare function normalizeControlPlaneURL(value: unknown): string;
export declare function normalizeAccountEmail(value: unknown): string;

export interface ControlPlaneUser {
  id: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
}

export interface ControlPlaneInstallation {
  id: string;
  clientInstanceId: string;
  name: string;
  platform: string;
  appVersion?: string | null;
  createdAt?: number;
  updatedAt?: number;
  lastSeenAt?: number | null;
}

export interface ControlPlaneEndpoint {
  url: string;
  hostname: string;
  status: string;
  generation?: number;
  updatedAt?: number;
  lastReconciledAt?: number | null;
  lastErrorCode?: string | null;
}

export interface ProductAiCredential {
  id: string;
  /** `omb_product_ai_…`: only ever held in memory by the account service. */
  token: string;
  expiresAt: number;
}

export interface PasswordCredential {
  /** Null when the deployment created the account but withheld a session until
   * its emailed code is confirmed. */
  accountToken: string | null;
  user: ControlPlaneUser;
}

export interface ControlPlaneClient {
  health(): Promise<unknown>;
  requestOTP(email: string): Promise<unknown>;
  verifyOTP(email: string, otp: string): Promise<{ accountToken: string; user: ControlPlaneUser }>;
  /** Public discovery: password always, email codes only with a mail transport. */
  authMethods(): Promise<import("../shared/product-account.ts").ProductAuthMethods>;
  signUpWithPassword(email: string, password: string): Promise<PasswordCredential>;
  signInWithPassword(email: string, password: string): Promise<{ accountToken: string; user: ControlPlaneUser }>;
  /** Confirms an address; no session is created. */
  verifyEmailOTP(email: string, otp: string): Promise<{ email: string }>;
  requestPasswordResetOTP(email: string): Promise<{ email: string }>;
  resetPasswordWithOTP(email: string, otp: string, password: string): Promise<{ email: string }>;
  me(accountToken: string): Promise<ControlPlaneUser>;
  aiStatus(accountToken: string): Promise<import("../shared/product-account.ts").ProductAiStatus>;
  /** 402/403/503 while the account may not start model work; the raw token is
   * handed to the local runtime only and never persisted. */
  createAiToken(accountToken: string, deviceId: string): Promise<ProductAiCredential>;
  revokeAiToken(accountToken: string, tokenId: string): Promise<void>;
  aiLedger(
    accountToken: string,
    cursor?: string,
  ): Promise<import("../shared/product-account.ts").ProductLedgerPage>;
  listInstallations(accountToken: string): Promise<ControlPlaneInstallation[]>;
  ensureInstallation(input: {
    accountToken: string;
    currentCredential: string;
    clientInstanceId: string;
    name: string;
    platform: string;
    appVersion?: string;
  }): Promise<{ installation: ControlPlaneInstallation; credential: string; credentialExpiresAt: number | null }>;
  /** `appVersion`, when printable and at most 64 characters, is sent as the
   * release this installation runs. */
  ensureEndpoint(
    installationCredential: string,
    options?: { appVersion?: string },
  ): Promise<{ endpoint: ControlPlaneEndpoint; connectorToken: string }>;
  getEndpoint(installationCredential: string): Promise<{ url: string; status: string } | null>;
  deleteEndpoint(installationCredential: string): Promise<void>;
  revokeInstallation(accountToken: string, installationId: string): Promise<void>;
  signOut(accountToken: string): Promise<void>;
}

export declare function createControlPlaneClient(options: {
  baseURL: string;
  /** The pinned public certificate of exactly this origin (resource v2). It is
   * trusted beside the platform roots for this client only; hostname checks,
   * chain checks and redirect refusal stay as they are. */
  ca?: string | null;
  fetchImpl?: typeof fetch;
  timeoutSignal?: (milliseconds: number) => AbortSignal;
  timeoutMs?: number;
  healthTimeoutMs?: number;
}): ControlPlaneClient;
