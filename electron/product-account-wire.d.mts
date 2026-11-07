export const PRODUCT_ACCOUNT_CHANNELS: Readonly<{
  state: "product-account:state";
  requestCode: "product-account:request-code";
  verifyCode: "product-account:verify-code";
  refresh: "product-account:refresh";
  ledger: "product-account:ledger";
  operatorStatus: "product-account:operator-status";
  grantMaximum: "product-account:grant-maximum";
  signOut: "product-account:sign-out";
  close: "product-account:close";
  stateChanged: "product-account:state-changed";
}>;

export declare function sanitizeProductAccountState(value: unknown): import("../shared/product-account").ProductAccountState;
export declare function sanitizeProductLedgerPage(value: unknown): import("../shared/product-account").ProductLedgerPage;
export declare function sanitizeProductOperatorStatus(value: unknown): import("../shared/product-account").ProductOperatorStatus;
export declare function sanitizeProductMaximumGrantResult(value: unknown): import("../shared/product-account").ProductMaximumGrantResult;
export declare function parseProductAiUpdate(value: unknown): {
  state: import("../shared/product-account").ProductAiState;
  connection: null | import("./product-account.mjs").ProductAiConnection;
};
export declare function unavailableProductAccountState(errorCode?: string): import("../shared/product-account").ProductAccountState;
