// The managed product's account window: only the account bridge, so the page
// cannot read this computer, the server, the workspace or any credential.
// Main decides who may answer; this file only forwards, and keeps no token.
const { contextBridge, ipcRenderer } = require("electron");

const stateListeners = new Set();
ipcRenderer.on("product-account:state-changed", (_event, state) => {
  if (!state || typeof state !== "object") return;
  for (const listener of stateListeners) listener(state);
});

/** The values a renderer may speak: text and an opaque cursor, nothing else. */
const text = (value, max) => (typeof value === "string" ? value.slice(0, max) : "");

contextBridge.exposeInMainWorld("ogb", {
  productAccount: {
    state: () => ipcRenderer.invoke("product-account:state"),
    requestCode: (email) => ipcRenderer.invoke("product-account:request-code", text(email, 254)),
    verifyCode: (email, code) => ipcRenderer.invoke("product-account:verify-code", text(email, 254), text(code, 8)),
    methods: () => ipcRenderer.invoke("product-account:methods"),
    signInWithPassword: (email, password) =>
      ipcRenderer.invoke("product-account:sign-in-password", text(email, 254), text(password, 128)),
    signUp: (email, password) => ipcRenderer.invoke("product-account:sign-up", text(email, 254), text(password, 128)),
    confirmEmail: (email, code, password) =>
      ipcRenderer.invoke("product-account:confirm-email", text(email, 254), text(code, 8), text(password, 128)),
    requestPasswordReset: (email) => ipcRenderer.invoke("product-account:request-password-reset", text(email, 254)),
    resetPassword: (email, code, password) =>
      ipcRenderer.invoke("product-account:reset-password", text(email, 254), text(code, 8), text(password, 128)),
    refresh: () => ipcRenderer.invoke("product-account:refresh"),
    operatorStatus: () => ipcRenderer.invoke("product-account:operator-status"),
    grantMaximum: () => ipcRenderer.invoke("product-account:grant-maximum"),
    ledger: (cursor) => ipcRenderer.invoke("product-account:ledger", ...(cursor === undefined ? [] : [text(cursor, 256)])),
    signOut: () => ipcRenderer.invoke("product-account:sign-out"),
    onState: (callback) => {
      if (typeof callback !== "function") return () => {};
      stateListeners.add(callback);
      return () => { stateListeners.delete(callback); };
    },
    /** The account window alone can dismiss itself; main decides whether that quits. */
    close: () => ipcRenderer.invoke("product-account:close"),
  },
});
