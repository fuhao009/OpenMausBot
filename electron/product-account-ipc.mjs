// window.ogb.productAccount's main half. Every call and every pushed state is
// checked against the exact document main approved for that window.
import {
  PRODUCT_ACCOUNT_CHANNELS,
  sanitizeProductAccountState,
  sanitizeProductLedgerPage,
  unavailableProductAccountState,
} from "./product-account-wire.mjs";
import { ownsDocument, showsDocument } from "./product-account-window.mjs";

const CURSOR = /^[A-Za-z0-9_-]{1,256}$/;
const PASSWORD_MIN = 10;
const PASSWORD_MAX = 128;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CODE = /^[0-9]{8}$/;
const ACCOUNT_ERROR = "The account controls are only available in this app's account window.";

const read = value => (typeof value === "function" ? value() : value);

function requireEmail(input) {
  if (typeof input !== "string") throw new Error("Enter the email address for your account.");
  const email = input.trim();
  if (email.length > 254 || !EMAIL.test(email)) throw new Error("Enter the email address for your account.");
  return email;
}

function requireCode(input) {
  if (typeof input !== "string") throw new Error("Enter the code from the email.");
  const code = input.trim();
  if (!CODE.test(code)) throw new Error("Enter the code from the email.");
  return code;
}

function requirePassword(input) {
  if (typeof input !== "string" || input.length < PASSWORD_MIN || input.length > PASSWORD_MAX) {
    throw new Error(`Use a password of ${PASSWORD_MIN} to ${PASSWORD_MAX} characters.`);
  }
  return input;
}

function requireCursor(input) {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "string" || !CURSOR.test(input)) throw new Error("That page of the account history is no longer available.");
  return input;
}

function accountTarget({ authWindow, authDocumentUrl }) {
  const handle = read(authWindow);
  if (!handle) return null;
  const managed = typeof handle.owns === "function" && handle.window;
  const win = managed ? handle.window : handle;
  if (!managed && authDocumentUrl === undefined) return null;
  const approved = () => (managed ? handle.documentUrl : read(authDocumentUrl));
  // A page close is the ordinary one so main's quit hook runs; a hand-off closes the handle instead.
  const close = () => win.close?.();
  return {
    window: win,
    documentUrl: approved,
    owns: event => (managed ? handle.owns(event) : ownsDocument(event, win, approved(), { accountPage: true })),
    shows: () => showsDocument(win, approved(), { accountPage: true }),
    close,
  };
}

function workspaceTarget({ workspaceWindow, workspaceDocumentUrl }) {
  if (workspaceWindow === undefined || workspaceDocumentUrl === undefined) return null;
  const win = read(workspaceWindow);
  if (!win) return null;
  return { win, documentUrl: read(workspaceDocumentUrl) };
}

const approvedNow = target => (typeof target.documentUrl === "function" ? target.documentUrl() : target.documentUrl);

const ownsWorkspace = (event, target) => (target ? ownsDocument(event, target.win, approvedNow(target)) : false);

function safeState(service, method, args = []) {
  const call = service?.[method];
  if (typeof call !== "function") return Promise.resolve(unavailableProductAccountState("account_unavailable"));
  return Promise.resolve()
    .then(() => call.apply(service, args))
    .then(sanitizeProductAccountState, error => {
      if (method === "state") return unavailableProductAccountState();
      throw error;
    });
}

/** Each of `service`, `authWindow`, `authDocumentUrl`, `workspaceWindow` and `workspaceDocumentUrl` is a value or a getter. */
export function installProductAccountIpc({
  ipcMain,
  service,
  authWindow,
  authDocumentUrl,
  workspaceWindow,
  workspaceDocumentUrl,
  onClose,
  onStateChanged,
} = {}) {
  if (!ipcMain || typeof ipcMain.handle !== "function") throw new Error("An ipcMain is required.");
  if (workspaceWindow !== undefined && workspaceDocumentUrl === undefined) {
    throw new Error("The workspace needs the exact document main approved.");
  }
  if (authDocumentUrl !== undefined && typeof authDocumentUrl !== "string" && typeof authDocumentUrl !== "function") {
    throw new Error("The account window's document address must be a string or a getter.");
  }
  const handlers = new Map();
  const serviceNow = () => read(service);
  const targets = () => ({
    auth: accountTarget({ authWindow, authDocumentUrl }),
    workspace: workspaceTarget({ workspaceWindow, workspaceDocumentUrl }),
  });

  const publish = (state) => {
    let safe;
    try { safe = sanitizeProductAccountState(state); }
    catch { safe = unavailableProductAccountState("state_unavailable"); }
    const { auth: account, workspace } = targets();
    if (account?.shows()) {
      try { account.window.webContents.send(PRODUCT_ACCOUNT_CHANNELS.stateChanged, safe); } catch { /* closing */ }
    }
    if (workspace && showsDocument(workspace.win, approvedNow(workspace))) {
      try { workspace.win.webContents.send(PRODUCT_ACCOUNT_CHANNELS.stateChanged, safe); } catch { /* closing */ }
    }
    onStateChanged?.(safe);
    return safe;
  };

  const register = (channel, handler) => {
    ipcMain.handle(channel, handler);
    handlers.set(channel, handler);
  };
  const requireSender = (event, which) => {
    const { auth: account, workspace } = targets();
    const allowed = which === "auth" ? Boolean(account?.owns(event))
      : which === "workspace" ? ownsWorkspace(event, workspace)
        : Boolean(account?.owns(event)) || ownsWorkspace(event, workspace);
    if (!allowed) throw new Error(ACCOUNT_ERROR);
  };

  register(PRODUCT_ACCOUNT_CHANNELS.state, async event => {
    requireSender(event, "any");
    try { return sanitizeProductAccountState(await safeState(serviceNow(), "state")); }
    catch { return unavailableProductAccountState("state_unavailable"); }
  });
  register(PRODUCT_ACCOUNT_CHANNELS.requestCode, async (event, email) => {
    requireSender(event, "auth");
    return publish(await safeState(serviceNow(), "requestCode", [requireEmail(email)]));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.verifyCode, async (event, email, code) => {
    requireSender(event, "auth");
    return publish(await safeState(serviceNow(), "verifyCode", [requireEmail(email), requireCode(code)]));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.methods, async event => {
    requireSender(event, "any");
    return publish(await safeState(serviceNow(), "methods"));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.signInWithPassword, async (event, email, password) => {
    requireSender(event, "auth");
    return publish(await safeState(serviceNow(), "signInWithPassword", [requireEmail(email), requirePassword(password)]));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.signUp, async (event, email, password) => {
    requireSender(event, "auth");
    return publish(await safeState(serviceNow(), "signUp", [requireEmail(email), requirePassword(password)]));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.confirmEmail, async (event, email, code, password) => {
    requireSender(event, "auth");
    return publish(await safeState(serviceNow(), "confirmEmail", [requireEmail(email), requireCode(code), requirePassword(password)]));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.requestPasswordReset, async (event, email) => {
    requireSender(event, "auth");
    return publish(await safeState(serviceNow(), "requestPasswordReset", [requireEmail(email)]));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.resetPassword, async (event, email, code, password) => {
    requireSender(event, "auth");
    return publish(await safeState(serviceNow(), "resetPassword", [requireEmail(email), requireCode(code), requirePassword(password)]));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.refresh, async event => {
    requireSender(event, "any");
    return publish(await safeState(serviceNow(), "refresh"));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.ledger, async (event, cursor) => {
    requireSender(event, "any");
    return sanitizeProductLedgerPage(await serviceNow().ledger(requireCursor(cursor)));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.signOut, async event => {
    requireSender(event, "any");
    return publish(await safeState(serviceNow(), "signOut"));
  });
  register(PRODUCT_ACCOUNT_CHANNELS.close, event => {
    requireSender(event, "auth");
    if (typeof onClose === "function") onClose();
    else targets().auth?.close();
  });

  return {
    publish,
    dispose() {
      for (const channel of handlers.keys()) ipcMain.removeHandler?.(channel);
      handlers.clear();
    },
  };
}
