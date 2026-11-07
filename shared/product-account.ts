export type ProductAiState = "pending" | "ready" | "insufficient_balance" | "suspended" | "unavailable";

export const PRODUCT_AI_INSUFFICIENT_BALANCE_MESSAGE =
  "Your available points cannot reserve this request. Contact your administrator.";

/** Prices are nonnegative safe-integer micro-points per million tokens. */
export interface ProductModel {
  id: string;
  label: string;
  protocol: "chat" | "responses";
  pricingVersion: string;
  inputMicroPointsPerMillion: number;
  cachedInputMicroPointsPerMillion: number;
  outputMicroPointsPerMillion: number;
  maxContextTokens: number;
  maxOutputTokens: number;
}

/** Amounts are nonnegative safe integers; one point is 1,000,000 micro-points. */
export interface ProductAiStatus {
  state: ProductAiState;
  /** The ledger unit; points are service credit, never currency. */
  unit: "points";
  availableMicroPoints: number;
  reservedMicroPoints: number;
  defaultModel: string | null;
  models: ProductModel[];
}

export interface ProductAccountState {
  auth: "signed_out" | "signing_in" | "signed_in" | "unavailable";
  runtime: "stopped" | "starting" | "ready" | "error";
  user?: { id: string; email: string };
  ai?: ProductAiStatus;
  errorCode?: string;
  /** The sign-in ways this deployment offers, once the service answered. */
  authMethods?: ProductAuthMethods;
  /** The address whose emailed code is outstanding (sign-up or reset). */
  pendingEmail?: string;
}

export interface ProductLedgerEntry {
  id: string;
  kind: "request" | "enable" | "disable" | "grant" | "settle";
  createdAt: number;
  model?: string;
  state?: "reserved" | "streaming" | "review" | "settled";
  amountMicroPoints?: number;
  reservedMicroPoints?: number;
  chargedMicroPoints?: number;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reason?: string;
}

export interface ProductLedgerPage {
  items: ProductLedgerEntry[];
  nextCursor: string | null;
}

/**
 * How this deployment signs people in. Password accounts always exist; emailed
 * codes only where the operator configured a mail transport. `emailVerification`
 * says whether a new password account must confirm its address with a code
 * before it gets a session.
 */
export interface ProductAuthMethods {
  password: { enabled: true; minLength: number; maxLength: number };
  emailCode: { enabled: boolean };
  emailVerification: "required" | "off";
}

/** Server-authorized read-only preview for the signed-in account only. */
export interface ProductOperatorStatus {
  eligible: boolean;
  availableMicroPoints?: number;
  reservedMicroPoints?: number;
  maxGrantMicroPoints?: number;
}

export interface ProductMaximumGrantResult {
  outcome: "granted" | "already_max" | "failed";
  amountMicroPoints: number;
  operationId?: string;
  errorCode?: string;
  state: ProductAccountState;
}

/**
 * The renderer receives account state, never account or model credentials.
 *
 * A password is an argument only: main hands it to the service and the service
 * to the Worker, and neither stores, logs nor returns one.
 */
export interface ProductAccountBridge {
  state(): Promise<ProductAccountState>;
  requestCode(email: string): Promise<ProductAccountState>;
  verifyCode(email: string, code: string): Promise<ProductAccountState>;
  refresh(): Promise<ProductAccountState>;
  operatorStatus(): Promise<ProductOperatorStatus>;
  /** Explicit operator action only; main chooses self identity and operation ID. */
  grantMaximum(): Promise<ProductMaximumGrantResult>;
  ledger(cursor?: string): Promise<ProductLedgerPage>;
  signOut(): Promise<ProductAccountState>;
  /** The ways in this deployment signs people in. */
  methods(): Promise<ProductAccountState>;
  signInWithPassword(email: string, password: string): Promise<ProductAccountState>;
  /** Creates the account; when verification is required the answer carries
   * `pendingEmail` and no session. */
  signUp(email: string, password: string): Promise<ProductAccountState>;
  /** Confirms a pending sign-up's emailed code and signs in. */
  confirmEmail(email: string, code: string, password: string): Promise<ProductAccountState>;
  requestPasswordReset(email: string): Promise<ProductAccountState>;
  resetPassword(email: string, code: string, password: string): Promise<ProductAccountState>;
  onState(cb: (state: ProductAccountState) => void): () => void;
  /** The account window alone: dismiss it; main decides whether that quits. */
  close?(): Promise<void>;
}
