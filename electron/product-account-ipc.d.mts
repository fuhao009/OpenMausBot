export interface ProductAccountIpcOptions {
  ipcMain: { handle(channel: string, handler: (...args: unknown[]) => unknown): void; removeHandler?(channel: string): void };
  /** The account service from electron/product-account.mjs, or a getter for it. */
  service: unknown;
  /** A createProductAccountWindow handle, a BrowserWindow, or a getter for either. */
  authWindow: unknown;
  /** The account window's exact page, when authWindow is a plain BrowserWindow. */
  authDocumentUrl?: string | (() => string | null | undefined);
  workspaceWindow?: unknown;
  /** Main's approved workspace document, e.g. `${rendererOrigin()}/`. */
  workspaceDocumentUrl?: string | (() => string | null | undefined);
  /** A close the page asked for; when absent the window is closed directly. */
  onClose?: () => void;
  onStateChanged?: (state: import("../shared/product-account").ProductAccountState) => void;
}

export interface ProductAccountIpc {
  /** Publishes a safe account state to the pages main approved. */
  publish(state: unknown): import("../shared/product-account").ProductAccountState;
  dispose(): void;
}

export declare function installProductAccountIpc(options: ProductAccountIpcOptions): ProductAccountIpc;
