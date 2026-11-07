// Types for product-account.mjs: the values main exchanges with the service
// and its private runtime callbacks. Renderers only ever see the shapes in
// shared/product-account.ts.
import type {
  ProductAccountState,
  ProductAuthMethods,
  ProductAiState,
  ProductAiStatus,
  ProductLedgerPage,
  ProductModel,
} from "../shared/product-account.ts";
import type { ControlPlaneClient } from "./control-plane-client.mjs";

export interface ProductAccountUser {
  id: string;
  email: string;
}

/**
 * The capability the local runtime may present to the gateway. `token` lives
 * only in memory: it is never written to the login record, config or renderer
 * storage, and it expires after fifteen minutes.
 */
export interface ProductAiConnection {
  origin: string;
  userId: string;
  tokenId: string;
  token: string;
  expiresAt: number;
  defaultModel: string | null;
  models: ProductModel[];
  /** The pinned public certificate of exactly `origin` (bundled resource v2).
   * Main passes it with the capability; it never reaches a renderer. */
  ca?: string;
}

export interface ProductRuntimeStart {
  /** The session generation this workspace belongs to. */
  generation: number;
  user: ProductAccountUser;
  /** sha256(origin + "\n" + user.id): the workspace's own directory name. */
  accountKey: string;
  /** Electron partition for this account's window, `persist:product-<key>`. */
  partition: string;
}

export interface ProductRuntimeStop {
  /** The generation of the runtime being stopped, not the current session. */
  generation: number;
  accountKey: string | null;
}

export interface ProductCapabilityUpdate {
  generation: number;
  accountKey: string | null;
  user: ProductAccountUser | null;
  state: ProductAiState;
  /** null removes any capability the runtime holds. */
  connection: ProductAiConnection | null;
}

export interface ProductAccountServiceOptions {
  client: ControlPlaneClient;
  store: {
    read(): Promise<unknown | null>;
    write(value: unknown | null): Promise<void>;
  };
  /** The exact service origin the login record is bound to. */
  origin: string;
  /** The pinned public certificate of exactly this origin, from the bundled
   * resource. It rides the capability to the runtime and is never stored in
   * the login record or published to a renderer. */
  ca?: string | null;
  /** Starts this account's workspace. Resolves once it can show local data. */
  startRuntime: (start: ProductRuntimeStart) => Promise<void>;
  /** Resolves only after the owned runtime and its children have exited. */
  stopRuntime: (stop: ProductRuntimeStop) => Promise<void>;
  /** Resolves only after the runtime acknowledged (or removed) the capability. */
  applyCapability: (update: ProductCapabilityUpdate) => Promise<void>;
  onState?: (state: ProductAccountState) => void;
  now?: () => number;
  statusPollMs?: number;
  renewLeadMs?: number;
  newDeviceId?: () => string;
  setTimer?: (callback: () => void, milliseconds: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface ProductAccountService {
  state(): Promise<ProductAccountState>;
  requestCode(email: string): Promise<ProductAccountState>;
  verifyCode(email: string, code: string): Promise<ProductAccountState>;
  /** Signs in with a password. The password is passed through and never kept. */
  signInWithPassword(email: string, password: string): Promise<ProductAccountState>;
  /** Creates the account; with verification required the answer names
   * `pendingEmail` and holds no session. */
  signUp(email: string, password: string): Promise<ProductAccountState>;
  /** Confirms a pending sign-up's emailed code and signs in. */
  confirmEmail(email: string, code: string, password: string): Promise<ProductAccountState>;
  requestPasswordReset(email: string): Promise<ProductAccountState>;
  resetPassword(email: string, code: string, password: string): Promise<ProductAccountState>;
  /** The sign-in ways this deployment offers, read once and published on state. */
  methods(): Promise<ProductAccountState>;
  refresh(): Promise<ProductAccountState>;
  /** Throws ControlPlaneError("signed_out") when nobody is signed in and
   * ("invalid_cursor") for a cursor that is not an opaque page token. */
  ledger(cursor?: string): Promise<ProductLedgerPage>;
  signOut(): Promise<ProductAccountState>;
  /** Reads the saved login, re-verifies it with /v1/me, then starts the
   * account workspace. Never deletes a record it cannot read. */
  restore(): Promise<ProductAccountState>;
  /** Cancels timers and clears the runtime capability. */
  dispose(): void;
  onState(callback: (state: ProductAccountState) => void): () => void;
}

export declare function productAccountKey(origin: string, userId: string): string;
export declare function productAccountPartition(accountKey: string): string;
/** Throws when the client, the record store or a runtime callback is missing:
 * a no-op runtime would read as signed in without any workspace. */
export declare function createProductAccountService(
  options: ProductAccountServiceOptions,
): ProductAccountService;

export type { ProductAiStatus, ProductAuthMethods };
