// A real local deployment of the account Worker: this repository's
// cloudflare/control-plane bundled with esbuild, run by the Miniflare that the
// control-plane's pinned Wrangler ships, over TLS on 127.0.0.1, with a real D1
// database (this checkout's migrations), the Worker's real EMAIL binding
// writing a disposable mailbox, and a real loopback upstream that the Worker
// reaches through its egress. Nothing here stubs a gateway response:
// account, OTP, operator, model-token, billing and usage paths are the
// production code in the Worker.
import { createServer as createHttpServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { join } from "node:path";
import tls from "node:tls";

import { PATHS, esbuild, miniflareRuntime, sqlSplitter } from "./runtime.mjs";

const MAIL_FROM = "noreply@fixture.test";
const SECRET = "fixture-better-auth-secret-with-at-least-32-chars";

export const MODELS = Object.freeze([{
  id: "hezuo-default",
  label: "Hezuo",
  protocol: "chat",
  pricingVersion: "fixture-v1",
  inputMicroPointsPerMillion: 2_000_000,
  cachedInputMicroPointsPerMillion: 500_000,
  outputMicroPointsPerMillion: 4_000_000,
  maxContextTokens: 100_000,
  maxOutputTokens: 1_000,
  upstreamModel: "fixture-upstream-model",
  chatMaxTokensField: "max_tokens",
  enabled: true,
}]);

/** The exact charge for one fixture reply: input 12, cached 2, output 3 tokens
 * at MODELS[0]'s rates, computed by the same formula the wallet uses. */
export const FIXTURE_USAGE = Object.freeze({ prompt_tokens: 12, completion_tokens: 3, cached_tokens: 2 });
export const FIXTURE_CHARGE_MICRO_POINTS = 33;

export function usageCharge({ prompt_tokens: input, completion_tokens: output, cached_tokens: cached }) {
  return Math.ceil(((input - cached) * MODELS[0].inputMicroPointsPerMillion
    + cached * MODELS[0].cachedInputMicroPointsPerMillion
    + output * MODELS[0].outputMicroPointsPerMillion) / 1_000_000);
}

async function freePort() {
  const server = createTcpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

/** A disposable certificate for 127.0.0.1 (openssl ships with the platforms
 * this fixture runs on; no network, no CA install). */
function certificate(directory) {
  const key = join(directory, "fixture-key.pem");
  const cert = join(directory, "fixture-cert.pem");
  if (!existsSync(key) || !existsSync(cert)) {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
      "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
  }
  return { key: readFileSync(key, "utf8"), certPem: readFileSync(cert, "utf8"), certPath: cert };
}

/** The fixture's own CA trusted by this Node process (its fetch for the
 * operator's session and the app's child both need it). */
export function trustFixtureCertificate(certPath) {
  const current = tls.getCACertificates("default");
  tls.setDefaultCACertificates([...current, readFileSync(certPath, "utf8")]);
}

/** Bundle the Worker exactly as a deploy would (its imports are the real
 * modules), once per run. */
export async function bundleWorker(outputDirectory) {
  mkdirSync(outputDirectory, { recursive: true });
  const outfile = join(outputDirectory, "index.js");
  const { build } = await esbuild();
  await build({
    entryPoints: [PATHS.workerEntry],
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    outfile,
    external: ["cloudflare:*", "node:*"],
    logLevel: "silent",
  });
  return readFileSync(outfile, "utf8");
}

/** A loopback upstream for the gateway: a real HTTPS server, called by the
 * Worker's own fetch through Miniflare's egress hook, streaming the same SSE a
 * compatible provider would. `scenario` decides which kind of reply the next
 * request gets; all usage is the fixture's fixed, priceable usage. */
async function startUpstream() {
  const state = { scenario: "text", calls: [] };
  // The Worker's configured base is HTTPS (its own validation requires it); this loopback hop is the
  // fixture's internal transport, rewritten by the egress hook below.
  const server = createHttpServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    let body = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const call = {
      path: request.url,
      authorization: request.headers.authorization,
      model: body.model,
      stream: body.stream === true,
      toolNames: Array.isArray(body.tools) ? body.tools.map(tool => tool?.function?.name).filter(Boolean) : [],
      hasToolResult: messages.some(message => message?.role === "tool"),
    };
    state.calls.push(call);
    const frame = value => `data: ${JSON.stringify(value)}\n\n`;
    const terminal = () => frame({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: FIXTURE_USAGE.prompt_tokens, completion_tokens: FIXTURE_USAGE.completion_tokens,
        prompt_tokens_details: { cached_tokens: FIXTURE_USAGE.cached_tokens } } }) + "data: [DONE]\n\n";
    if (call.path === "/v1/models" || call.path.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: MODELS.map(model => ({ id: model.upstreamModel })) }));
      return;
    }
    if (!call.path.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "fixture has no such route" } }));
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if ((state.scenario === "tool" || state.scenario === "deny") && !call.hasToolResult) {
      const name = call.toolNames.find(candidate => /write/i.test(candidate)) ?? call.toolNames[0];
      if (!name) {
        response.end(frame({ choices: [{ index: 0, delta: { content: "No write tool was offered." } }] }) + terminal());
        return;
      }
      response.end(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "fixture-call", type: "function",
        function: { name, arguments: JSON.stringify({ content: "verified" }) } }] } }] }) + terminal());
      return;
    }
    if (state.scenario === "tool" && call.hasToolResult) {
      response.end(frame({ choices: [{ index: 0, delta: { content: "The file is written." } }] }) + terminal());
      return;
    }
    if (state.scenario === "deny" && call.hasToolResult) {
      response.end(frame({ choices: [{ index: 0, delta: { content: "The write was denied." } }] }) + terminal());
      return;
    }
    const text = "Hello from your account.";
    response.end(frame({ choices: [{ index: 0, delta: { content: text } }] }) + terminal());
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    port: server.address().port,
    state,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}

function migrationStatements(split, sql) {
  return split(sql).map(statement => statement.trim()).filter(Boolean);
}

/**
 * Starts the Worker for the fixture's lifetime. `restart(operatorUserIds)`
 * re-applies the same persisted D1 and origin with the operator list, which is
 * how the real bootstrap turn (an operator id learned from `/v1/me`) is
 * modelled. The certificate is reused so the desktop origin never changes.
 */
export async function startWorkerFixture({ root, log = () => {}, mail = true }) {
  const directory = join(root, "worker");
  mkdirSync(directory, { recursive: true });
  const { key, certPem, certPath } = certificate(directory);
  const script = await bundleWorker(join(root, "worker-bundle"));
  const upstream = await startUpstream();
  const split = await sqlSplitter();
  const port = await freePort();
  const origin = `https://127.0.0.1:${port}`;
  const state = { operatorUserIds: [], mail, instance: null, db: null };

  const options = () => {
    const runtime = state.runtime;
    return runtime.convertV4MiniflareOptions({
      host: "127.0.0.1",
      port,
      https: true,
      httpsKey: key,
      httpsCert: certPem,
      name: "product-fixture",
      compatibilityDate: "2026-08-25",
      compatibilityFlags: ["nodejs_compat"],
      modules: true,
      script,
      bindings: {
        BETTER_AUTH_SECRET: SECRET,
        BETTER_AUTH_URL: origin,
        ALLOWED_ORIGINS: origin,
        AUTH_EMAIL_VERIFICATION: state.mail ? "required" : "off",
        ...(state.mail ? { EMAIL_FROM: MAIL_FROM } : {}),
        AI_MODELS: JSON.stringify(MODELS),
        AI_DEFAULT_MODEL: MODELS[0].id,
        AI_OPERATOR_USER_IDS: JSON.stringify(state.operatorUserIds),
        AI_UPSTREAM_API_KEY: "fixture-upstream-key",
        AI_UPSTREAM_BASE_URL: `https://ai.fixture.test/v1`,
      },
      d1Databases: { DB: "product-fixture" },
      ...(state.mail ? { email: { send_email: [{ name: "EMAIL", allowed_sender_addresses: [MAIL_FROM] }] } } : {}),
      // The gateway's own egress: a genuine request to the loopback upstream,
      // with its real path, headers and body. `fetch` here runs in Node, not in
      // the Worker, so it is the only place the fixture touches the network.
      outboundService: async request => {
        const target = new URL(request.url);
        const url = `http://127.0.0.1:${upstream.port}${target.pathname}${target.search}`;
        return fetch(url, {
          method: request.method,
          headers: request.headers,
          body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
          redirect: "manual",
        });
      },
      resourceTmpPath: join(root, "worker-tmp"),
      resourcePersistencePath: join(root, "worker-state"),
    });
  };

  async function start() {
    const runtime = await miniflareRuntime();
    state.runtime = runtime;
    state.instance = new runtime.Miniflare(options());
    await state.instance.ready;
    state.db = await state.instance.getD1Database("DB");
  }

  async function applyMigrations() {
    const files = readdirSync(PATHS.migrations).filter(file => file.endsWith(".sql")).sort();
    for (const file of files) {
      const sql = readFileSync(join(PATHS.migrations, file), "utf8");
      const statements = migrationStatements(split, sql);
      try {
        await state.db.batch(statements.map(statement => state.db.prepare(statement)));
      } catch (error) {
        throw new Error(`fixture migration ${file} failed: ${error?.message ?? error}`);
      }
    }
    log(`worker migrations applied (${files.length})`);
  }

  await start();
  await applyMigrations();
  log(`worker ready at ${origin}`);

  let mailWatch = 0;
  const mailRoot = join(root, "worker-tmp");
  function mailFiles() {
    const found = [];
    const walk = directoryName => {
      let entries;
      try { entries = readdirSync(directoryName, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const path = join(directoryName, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (path.includes("email-text") && path.endsWith(".txt")) found.push(path);
      }
    };
    walk(mailRoot);
    return found.sort();
  }
  /** The fixture mailbox: the Worker's own EMAIL binding wrote these files. */
  const existingMail = new Set(mailFiles());
  async function nextCode(timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const fresh = mailFiles().filter(file => !existingMail.has(file));
      for (const file of fresh) {
        const text = readFileSync(file, "utf8");
        const code = text.match(/\b(\d{8})\b/)?.[1];
        if (code) {
          existingMail.add(file);
          mailWatch += 1;
          return code;
        }
      }
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    throw new Error("fixture mailbox received no code");
  }

  return {
    origin,
    certPath,
    certPem,
    models: MODELS,
    upstream,
    mail: { nextCode, count: () => mailWatch, files: mailFiles },
    db: () => state.db,
    /** Restart with the operator ids the real bootstrap printed, and
     * optionally without a mail transport (the deployment that verifies
     * nothing and signs people up with a password alone). */
    async restart(operatorUserIds, { mail = state.mail } = {}) {
      state.operatorUserIds = [...operatorUserIds];
      state.mail = mail;
      await state.instance.dispose();
      await start();
      log(`worker restarted with ${operatorUserIds.length} operator id(s)`);
    },
    async close() {
      await upstream.close().catch(() => {});
      await state.instance?.dispose().catch(() => {});
    },
  };
}
