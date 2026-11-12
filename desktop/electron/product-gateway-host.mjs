// Registers this desktop as an installation on the local Hezuo account
// gateway and keeps a companion relay open so a phone signed into the same
// account can use the app without a pairing code, Cloudflare tunnel, or
// Tailscale name.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { companionUrlFor, createGatewayCompanionTunnel } from "./gateway-companion-tunnel.mjs";

const STATE_FILE = "gateway-host.json";
const TRUST_FILE = "product-account-trust.json";
const CLIENT_ID_FILE = "gateway-host-client-id";

function ownString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readJSON(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, value, { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function writeProductAccountTrust(root, { origin, ca, userId }) {
  if (!root) return null;
  const file = path.join(root, TRUST_FILE);
  writePrivate(file, `${JSON.stringify({ origin, ca, userId }, null, 2)}\n`);
  return file;
}

export function clearProductAccountTrust(root) {
  if (!root) return;
  for (const name of [TRUST_FILE]) {
    try { fs.unlinkSync(path.join(root, name)); } catch { /* already gone */ }
  }
}

export function readProductAccountTrust(file) {
  const raw = readJSON(file);
  if (!raw || typeof raw !== "object") return null;
  const origin = ownString(raw.origin);
  const ca = ownString(raw.ca);
  const userId = ownString(raw.userId);
  if (!origin || !ca || !userId) return null;
  return { origin, ca, userId };
}

function clientInstanceId(root) {
  const file = path.join(root, CLIENT_ID_FILE);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing.toLowerCase();
    }
  } catch { /* first run */ }
  const id = randomUUID();
  writePrivate(file, `${id}\n`);
  return id;
}

function storedHost(root) {
  const raw = readJSON(path.join(root, STATE_FILE));
  if (!raw || typeof raw !== "object") return null;
  const installationId = ownString(raw.installationId);
  const credential = ownString(raw.credential);
  const clientId = ownString(raw.clientInstanceId);
  if (!installationId || !credential || !clientId) return null;
  return { installationId, credential, clientInstanceId: clientId, credentialExpiresAt: raw.credentialExpiresAt ?? null };
}

function persistHost(root, record) {
  writePrivate(path.join(root, STATE_FILE), `${JSON.stringify(record, null, 2)}\n`);
}

export function createProductGatewayHost({
  origin,
  ca,
  root,
  client,
  identity,
  originTarget,
  log = () => {},
} = {}) {
  if (!origin || !ca || !root || !client) throw new Error("product_gateway_host_invalid");
  let tunnel = null;
  let started = false;

  const ensure = async ({ token, user }) => {
    const clientId = storedHost(root)?.clientInstanceId || clientInstanceId(root);
    const current = storedHost(root);
    const result = await client.ensureInstallation({
      accountToken: token,
      currentCredential: current?.credential,
      clientInstanceId: clientId,
      name: identity?.name || "This computer",
      platform: identity?.platform || "darwin",
      appVersion: identity?.appVersion,
    });
    persistHost(root, {
      installationId: result.installation.id,
      clientInstanceId: clientId,
      credential: result.credential,
      credentialExpiresAt: result.credentialExpiresAt,
    });
    writeProductAccountTrust(root, { origin, ca, userId: user.id });
    return {
      installationId: result.installation.id,
      credential: result.credential,
      endpoint: companionUrlFor(origin, result.installation.id),
    };
  };

  return {
    trustFile: path.join(root, TRUST_FILE),
    async register({ token, user }) {
      return ensure({ token, user });
    },
    async start({ token, user, originTarget: target = originTarget } = {}) {
      const host = await ensure({ token, user });
      if (!target) return host;
      if (!tunnel) {
        tunnel = createGatewayCompanionTunnel({
          origin,
          ca,
          installationId: host.installationId,
          credential: host.credential,
          originTarget: target,
          log,
        });
      }
      started = true;
      const status = await tunnel.start(target);
      return { ...host, connection: status };
    },
    async stop() {
      started = false;
      await tunnel?.stop();
    },
    status() {
      return tunnel?.getStatus() ?? { status: "stopped", ready: false, configured: Boolean(storedHost(root)) };
    },
    endpoint() {
      const current = storedHost(root);
      return current ? companionUrlFor(origin, current.installationId) : null;
    },
    isStarted() {
      return started;
    },
  };
}
