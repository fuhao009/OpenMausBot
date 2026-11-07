export interface ProductAccountWindowOptions {
  BrowserWindow: new (options: Record<string, unknown>) => unknown;
  url: string;
  preload?: string;
  partition?: string;
  iconPath?: string;
  parent?: unknown;
  title?: string;
  width?: number;
  height?: number;
  show?: boolean;
  /** The person dismissed the window; main decides whether that quits the app. */
  onClose?: () => void;
}

/** A window plus the exact document it may answer for. */
export interface ProductAccountWindowHandle {
  window: {
    webContents: { send(channel: string, ...args: unknown[]): void; mainFrame?: { url: string } };
    isDestroyed?(): boolean;
    close?(): void;
  };
  loaded: Promise<void>;
  readonly documentUrl: string;
  readonly disposed: boolean;
  owns(event: unknown): boolean;
  /** Sends the safe state, or null when the window is not on its account page. */
  sendState(state: unknown): import("../shared/product-account").ProductAccountState | null;
  /** A hand-off's close: `onClose` is not called. */
  close(): void;
}

export declare function normalizeLocalDocumentUrl(value: unknown): string | null;
export declare function normalizeAccountDocumentUrl(value: unknown): string | null;
export declare function showsDocument(win: unknown, documentUrl: unknown, options?: { accountPage?: boolean }): boolean;
export declare function ownsDocument(event: unknown, win: unknown, documentUrl: unknown, options?: { accountPage?: boolean }): boolean;
export declare function createProductAccountWindow(options: ProductAccountWindowOptions): ProductAccountWindowHandle;
