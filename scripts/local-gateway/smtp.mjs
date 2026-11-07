// A minimal SMTP submission client for the local gateway's real mail
// transport. The Worker never sees these settings: it calls its `EMAIL`
// binding, the binding forwards the message object to this process over a
// fetch service binding, and only here do SMTP credentials exist (read from
// the 0600 gateway config, never argv, logs, or the repository).
//
// Supported URLs:
//   smtps://user:pass@smtp.example.com:465   implicit TLS
//   smtp://user:pass@smtp.example.com:587    STARTTLS (required)
//
// No message body, address, or code is ever logged by this module.
import net from "node:net";
import tls from "node:tls";

const SMTP_TIMEOUT_MS = 30_000;

export class SmtpError extends Error {
  constructor(code) {
    super(code);
    this.name = "SmtpError";
  }
}

/** Parses and validates an SMTP submission URL. Throws a stable code; never
 * includes the credential in the message. */
export function parseSmtpURL(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new SmtpError("smtp_url_invalid");
  }
  if (url.protocol !== "smtps:" && url.protocol !== "smtp:") throw new SmtpError("smtp_url_scheme");
  if (!url.hostname) throw new SmtpError("smtp_url_host");
  const implicitTLS = url.protocol === "smtps:";
  const port = url.port ? Number(url.port) : implicitTLS ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new SmtpError("smtp_url_port");
  const user = decodeURIComponent(url.username ?? "");
  const pass = decodeURIComponent(url.password ?? "");
  if ((user === "") !== (pass === "")) throw new SmtpError("smtp_url_credentials");
  // `smtp:` is a non-special scheme: URL keeps the empty path as "" here.
  if ((url.pathname !== "" && url.pathname !== "/") || url.search || url.hash) throw new SmtpError("smtp_url_invalid");
  return { host: url.hostname.replace(/^\[|\]$/g, ""), port, implicitTLS, user, pass };
}

function encodeHeader(value) {
  const text = String(value ?? "");
  // Non-ASCII header text travels as an encoded word; ASCII passes through.
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

function normalizeRecipients(message) {
  const to = Array.isArray(message.to) ? message.to : [message.to];
  const addresses = to.map((entry) => (typeof entry === "string" ? entry : entry?.address ?? "")).filter(Boolean);
  if (addresses.length === 0) throw new SmtpError("smtp_recipient_missing");
  return addresses;
}

function buildMime(message, fromEmail) {
  const boundary = `omb-${Buffer.from(`${Date.now()}-${Math.random()}`).toString("hex")}`;
  const text = String(message.text ?? "");
  const html = String(message.html ?? "");
  const headers = [
    `From: ${encodeHeader(message.from?.name ?? "OpenMausBot")} <${fromEmail}>`,
    `To: ${normalizeRecipients(message).join(", ")}`,
    `Subject: ${encodeHeader(message.subject ?? "")}`,
    "MIME-Version: 1.0",
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${Buffer.from(`${Date.now()}-${Math.random()}`).toString("hex")}@local-gateway>`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ];
  const body = [
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(text, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    `--${boundary}`,
    'Content-Type: text/html; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64").replace(/(.{76})/g, "$1\r\n"),
    `--${boundary}--`,
    "",
  ];
  // A line that starts with a dot must be dot-stuffed by the DATA writer.
  return [...headers, ...body].join("\r\n");
}

/** One SMTP conversation per message: connect, EHLO, (STARTTLS), AUTH, send. */
class Session {
  constructor(socket, timeoutMs = SMTP_TIMEOUT_MS) {
    this.socket = socket;
    this.buffer = "";
    this.waiters = [];
    this.timeoutMs = timeoutMs;
    // idle timeout while a reply is awaited
    socket.setTimeout(timeoutMs, () => this.fail(new SmtpError("smtp_timeout")));
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new SmtpError("smtp_closed")));
    socket.on("end", () => this.fail(new SmtpError("smtp_closed")));
  }

  fail(error) {
    const waiters = this.waiters;
    this.waiters = [];
    this.error = error instanceof SmtpError ? error : new SmtpError("smtp_connection");
    for (const waiter of waiters) waiter.reject(this.error);
  }

  flush() {
    while (this.waiters.length > 0) {
      const end = this.buffer.indexOf("\r\n");
      if (end < 0) return;
      const line = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const waiter = this.waiters[0];
      waiter.lines.push(line);
      // A reply ends with `<code><space>`; `<code>-` continues the reply.
      if (/^\d{3} /.test(line)) {
        this.waiters.shift();
        waiter.resolve(waiter.lines);
      }
    }
  }

  read() {
    if (this.error) return Promise.reject(this.error);
    this.socket.setTimeout(this.timeoutMs);
    return new Promise((resolve, reject) => {
      this.waiters.push({ lines: [], resolve, reject });
      // A reply can arrive before its waiter exists (the greeting, or a fast
      // server); drain what is already buffered instead of waiting forever.
      this.flush();
    });
  }

  async command(text, expect = [2]) {
    if (this.error) throw this.error;
    this.socket.write(`${text}\r\n`);
    const lines = await this.read();
    const status = Number(lines.at(-1)?.slice(0, 3));
    if (!expect.some((prefix) => Math.floor(status / 100) === prefix)) {
      throw new SmtpError(`smtp_reply_${Number.isFinite(status) ? status : "invalid"}`);
    }
    return lines;
  }
}

function connect({ host, port, implicitTLS, ca }) {
  return new Promise((resolve, reject) => {
    // `ca` is the operator's own trust decision for this hop (a private SMTP
    // certificate). It is passed per connection, so no global TLS state is
    // changed and verification stays on.
    const socket = implicitTLS
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca } : {}) })
      : net.connect({ host, port });
    // A connect timeout is the connection attempt's own bound; once Session
    // exists, Socket.setTimeout bounds every awaited reply instead.
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new SmtpError("smtp_timeout"));
    }, SMTP_TIMEOUT_MS);
    const ready = implicitTLS ? "secureConnect" : "connect";
    let settled = false;
    // The handler stays attached for the connection's whole life: a TLS
    // failure can arrive after `secureConnect` (a certificate is only checked
    // while the handshake finishes) and must never crash the process.
    const onError = (error) => {
      clearTimeout(timer);
      const code = error instanceof SmtpError
        ? error
        : new SmtpError(error?.code === "DEPTH_ZERO_SELF_SIGNED_CERT" || error?.code?.includes?.("CERT")
          ? "smtp_tls_certificate"
          : "smtp_connection");
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      reject(code);
    };
    socket.on("error", onError);
    socket.once(ready, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(socket);
    });
  });
}

function upgradeTLS(socket, host, ca) {
  return new Promise((resolve, reject) => {
    const secure = tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ...(ca ? { ca } : {}) });
    secure.once("secureConnect", () => resolve(secure));
    secure.once("error", () => reject(new SmtpError("smtp_tls")));
  });
}

/**
 * Sends one message. `smtp` is `{ url }` (parsed here) or a parsed descriptor.
 * Resolves once the server accepts the message; rejects with a stable code.
 */
export async function sendSmtpMessage(smtp, message) {
  const target = typeof smtp === "string" ? parseSmtpURL(smtp) : smtp;
  const fromEmail = String(message.from?.email ?? "").trim();
  if (!fromEmail) throw new SmtpError("smtp_sender_missing");
  let socket = await connect(target);
  try {
    let session = new Session(socket);
    await session.read();
    let ehlo = await session.command("EHLO local-gateway");
    if (!target.implicitTLS) {
      const offers = ehlo.map((line) => line.slice(4).toLowerCase()).join(" ");
      if (!offers.includes("starttls")) throw new SmtpError("smtp_starttls_unsupported");
      await session.command("STARTTLS", [2]);
      session.socket.removeAllListeners();
      socket = await upgradeTLS(socket, target.host, target.ca);
      session = new Session(socket);
      ehlo = await session.command("EHLO local-gateway");
    }
    if (target.user) {
      const token = Buffer.from(`\u0000${target.user}\u0000${target.pass}`, "utf8").toString("base64");
      await session.command(`AUTH PLAIN ${token}`, [2]);
    }
    await session.command(`MAIL FROM:<${fromEmail}>`, [2]);
    for (const recipient of normalizeRecipients(message)) {
      await session.command(`RCPT TO:<${recipient}>`, [2, 3]);
    }
    await session.command("DATA", [3]);
    const mime = buildMime(message, fromEmail).split("\r\n").map((line) => (line.startsWith(".") ? `.${line}` : line));
    await session.command(`${mime.join("\r\n")}\r\n.`, [2]);
    await session.command("QUIT", [2]).catch(() => {});
  } finally {
    socket.destroy();
  }
}
