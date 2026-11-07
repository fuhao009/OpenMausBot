#!/usr/bin/env node
// Operator CLI for the hosted product's account AI surface: look an account up,
// open or close its AI permission, grant balance, page its requests, and settle
// a reviewed request. Signed-in operators only; the account bearer stays in
// memory and is never written to argv, a file, or the output.
//
//   node scripts/account-ai-admin.mjs whoami --origin https://ai.example.com --operator-email ops@example.com
//   node scripts/account-ai-admin.mjs lookup --origin … --operator-email … --email person@example.com
//   node scripts/account-ai-admin.mjs enable --origin … --operator-email … --user-id ID --operation-id UUID --reason TEXT
//   node scripts/account-ai-admin.mjs disable --origin … --operator-email … --user-id ID --operation-id UUID --reason TEXT
//   node scripts/account-ai-admin.mjs grant --origin … --operator-email … --user-id ID --points 10.000000 --operation-id UUID --reason TEXT
//   node scripts/account-ai-admin.mjs requests --origin … --operator-email … --user-id ID [--cursor CURSOR]
//   node scripts/account-ai-admin.mjs settle --origin … --operator-email … --request-id ID --points 0 --operation-id UUID --reason TEXT
//
// Non-interactive deployments may set OMB_OPERATOR_TOKEN to a signed account
// bearer instead of answering the OTP prompt. Mutations are never retried: a
// lost response is resolved by looking the account or request up again, never
// by resending the same write blindly.
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { ControlPlaneError, createControlPlaneClient, normalizeAccountEmail } from "../electron/control-plane-client.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const POINTS = /^(0|[1-9][0-9]{0,12})(?:\.([0-9]{1,6}))?$/;

const HELP = `account-ai-admin — hosted product account AI administration

commands:
  whoami    print the signed-in operator's id and email (bootstrap AI_OPERATOR_USER_IDS)
  lookup    --email EMAIL            find a verified account by exact email
  enable    --user-id ID --operation-id UUID --reason TEXT
  disable   --user-id ID --operation-id UUID --reason TEXT
  grant     --user-id ID --points AMOUNT --operation-id UUID --reason TEXT
  requests  --user-id ID [--cursor CURSOR]
  settle    --request-id ID --points AMOUNT --operation-id UUID --reason TEXT

options:
  --origin URL            control-plane origin (required, HTTPS or loopback dev)
  --operator-email EMAIL  operator account to sign in as
  --password              ask for the account password on the terminal
                          (the default whenever the deployment offers no
                          emailed codes; a password is never an argument)
  --json                  print the server result as JSON
  --help                  this text

signing in: OMB_OPERATOR_TOKEN if set, else this account's password, else the
emailed code. A password is read from the terminal without echo (or from
OMB_OPERATOR_PASSWORD for unattended runs) and is never written to argv, a
file, or the output.

environment:
  OMB_OPERATOR_TOKEN      signed account bearer for unattended runs; never printed
  OMB_OPERATOR_PASSWORD   password for unattended runs; never printed
`;

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

/** One point is 1,000,000 micro-points. Exact decimal parsing, no float
 * arithmetic, at most six decimals (the micro-point precision). */
export function pointsToMicroPoints(input) {
  const value = String(input ?? "").trim();
  const match = POINTS.exec(value);
  if (!match) fail(`--points must be a nonnegative decimal with at most six places, got ${JSON.stringify(value)}`);
  const whole = BigInt(match[1]) * 1_000_000n;
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  const micro = whole + fraction;
  if (micro > BigInt(Number.MAX_SAFE_INTEGER)) fail("--points is out of range");
  return Number(micro);
}

function requireText(options, name) {
  const value = options[name];
  if (typeof value !== "string" || value.trim() === "") fail(`--${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required`);
  return value.trim();
}

function requireOperationId(options) {
  const value = requireText(options, "operationId");
  if (!UUID.test(value)) fail("--operation-id must be a UUID");
  return value;
}

function requireReason(options) {
  const value = requireText(options, "reason");
  if (value.length > 500) fail("--reason must be at most 500 characters");
  for (const character of value) {
    const point = character.codePointAt(0);
    if (point < 32 || point === 127) fail("--reason must be a single printable line");
  }
  return value;
}

/** Reads one line from the terminal without echoing it. A pipe or a CI
 * terminal cannot mask, so those are refused rather than echoed — the caller
 * then has the environment variable or the emailed code to fall back on. */
export async function askHidden(question, input, output, { mask = null, maximum = 512 } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    fail(`cannot read ${question.trim().toLowerCase()} without an interactive terminal; use the environment variable or the emailed code`);
  }
  output.write(question);
  input.setRawMode(true);
  input.resume();
  return await new Promise((resolve, reject) => {
    let answer = "";
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
    };
    const onData = (chunk) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          output.write("\n");
          reject(new CliError("cancelled"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          output.write("\n");
          resolve(answer);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            if (mask !== null) output.write("\b \b");
          }
          continue;
        }
        if (character === "\u0004") {
          // Ctrl-D ends input the way a shell does, with what was typed.
          cleanup();
          output.write("\n");
          resolve(answer);
          return;
        }
        if (answer.length >= maximum) continue;
        if (mask !== null) {
          if (!new RegExp(mask).test(character)) continue;
          output.write("*");
        }
        answer += character;
      }
    };
    input.on("data", onData);
  });
}

/** The account password for this run: the environment when set (unattended
 * deployments), otherwise a non-echoing prompt. Never argv, never a file. */
async function accountPassword(io, environment = process.env) {
  const fromEnvironment = environment.OMB_OPERATOR_PASSWORD;
  if (typeof fromEnvironment === "string" && fromEnvironment !== "") return fromEnvironment;
  return await askHidden("Password: ", io.stdin, io.stdout, { mask: "[\\s\\S]", maximum: 256 });
}

/** The signed-in operator. The bearer comes from the environment, a password
 * prompt, or an OTP prompt — never from argv — and stays in this process.
 *
 * A deployment without a mail transport answers `emailCode.enabled: false`;
 * there is no code to ask for, so the password form is used without needing
 * `--password`. Where both exist the emailed code stays the default, as it was,
 * unless `--password` was passed explicitly. */
export async function signedInOperator(options, io, { client: injected = null, environment = process.env } = {}) {
  const origin = requireText(options, "origin");
  const client = injected ?? createControlPlaneClient({ baseURL: origin });
  const provided = environment.OMB_OPERATOR_TOKEN?.trim();
  if (provided) {
    const user = await client.me(provided);
    return { origin: client.origin ?? origin, token: provided, user };
  }

  const email = normalizeAccountEmail(options.operatorEmail);
  if (!email) fail("--operator-email is required unless OMB_OPERATOR_TOKEN is set");
  // The account and the operator address are separate permissions: signing in
  // proves the operator identity, which AI_OPERATOR_USER_IDS must also list.
  let emailCode = true;
  try {
    emailCode = (await client.authMethods()).emailCode.enabled;
  } catch (error) {
    // A deployment too old to answer /v1/auth/methods is the OTP-only one.
    if (!(error instanceof ControlPlaneError)) throw error;
  }
  if (options.password || !emailCode || environment.OMB_OPERATOR_PASSWORD) {
    const password = await accountPassword(io, environment);
    try {
      const signedIn = await client.signInWithPassword(email, password);
      return { origin: client.origin ?? origin, token: signedIn.accountToken, user: signedIn.user };
    } catch (error) {
      if (!(error instanceof ControlPlaneError) || !emailCode) throw error;
      // A password account on a deployment that also sends codes may simply
      // not have a password; the code still works.
      io.stdout.write(`Password sign-in was refused (${error.code}); asking for an emailed code instead.\n`);
    }
  }
  await client.requestOTP(email);
  io.stdout.write(`A sign-in code was sent to ${email}.\n`);
  const code = await askHidden("Verification code: ", io.stdin, io.stdout, { mask: "[0-9]", maximum: 8 });
  if (!/^[0-9]{8}$/.test(code)) fail("the verification code is eight digits");
  const { accountToken, user } = await client.verifyOTP(email, code);
  return { origin: client.origin ?? origin, token: accountToken, user };
}

async function operatorRequest(session, path, { method = "GET", body } = {}) {
  const headers = new Headers({ accept: "application/json" });
  headers.set("authorization", `Bearer ${session.token}`);
  const init = { method, headers, redirect: "error", signal: AbortSignal.timeout(20_000) };
  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(`${session.origin}${path}`, init);
  } catch {
    throw new ControlPlaneError("network_unavailable");
  }
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload && typeof payload === "object" && typeof payload.error === "string" ? payload.error : null;
    throw new ControlPlaneError(
      code ?? (response.status === 404 ? "not_found" : "request_failed"),
      response.status,
      response.headers.get("x-request-id") ?? "",
    );
  }
  return payload;
}

function formatPoints(microPoints) {
  const micro = BigInt(microPoints);
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, "0")}`;
}

function describeAccount(account) {
  return [
    `user ${account.userId} <${account.email}>`,
    `state ${account.state}`,
    `enabled ${account.enabled ? "yes" : "no"}`,
    `available ${formatPoints(account.availableMicroPoints)} points`,
    `reserved ${formatPoints(account.reservedMicroPoints)} points`,
  ].join("\n");
}

function describeRequest(item) {
  const usage = item.inputTokens == null
    ? "usage pending review"
    : `${item.inputTokens} input (${item.cachedInputTokens} cached), ${item.outputTokens} output`;
  return [
    `${item.id} ${item.state} ${item.model} ${item.endpoint}`,
    `  reserved ${formatPoints(item.reservedMicroPoints)} points`
      + `${item.chargedMicroPoints == null ? "" : `, charged ${formatPoints(item.chargedMicroPoints)} points`}`,
    `  ${usage}`,
    ...(item.settlementReason == null ? [] : [`  reason ${item.settlementReason}`]),
  ].join("\n");
}

export async function run(argv = process.argv.slice(2), io = process) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      origin: { type: "string" },
      "operator-email": { type: "string" },
      email: { type: "string" },
      "user-id": { type: "string" },
      "request-id": { type: "string" },
      "operation-id": { type: "string" },
      reason: { type: "string" },
      points: { type: "string" },
      cursor: { type: "string" },
      password: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });
  const options = {
    ...values,
    operatorEmail: values["operator-email"],
    userId: values["user-id"],
    requestId: values["request-id"],
    operationId: values["operation-id"],
  };
  const command = positionals[0];
  if (values.help || command === undefined) {
    io.stdout.write(HELP);
    return 0;
  }
  // A password must never arrive as an argument: `--password secret` would put
  // it in the shell history and the process list. Only the flag is accepted.
  if (positionals.length > 1) fail(`unexpected argument: ${positionals[1]} (a password is never taken as an argument; pass --password alone)`);

  const print = (value) => io.stdout.write(`${value}\n`);
  if (command === "whoami") {
    const session = await signedInOperator(options, io);
    if (values.json) print(JSON.stringify({ userId: session.user.id, email: session.user.email }));
    else print(`${session.user.id}\n${session.user.email}`);
    return 0;
  }

  const session = await signedInOperator(options, io);

  if (command === "lookup") {
    const email = normalizeAccountEmail(options.email);
    if (!email) fail("--email must be a verified account email");
    const result = await operatorRequest(session, `/v1/operator/ai/account?email=${encodeURIComponent(email)}`);
    print(values.json ? JSON.stringify(result) : describeAccount(result.account));
    return 0;
  }

  if (command === "enable" || command === "disable") {
    const operationId = requireOperationId(options);
    const userId = requireText(options, "userId");
    const reason = requireReason(options);
    const result = await operatorRequest(session, "/v1/operator/ai/account", {
      method: "POST",
      body: { operationId, userId, enabled: command === "enable", reason },
    });
    print(values.json ? JSON.stringify(result) : `${describeAccount(result.account)}\n${result.replayed ? "already applied" : "applied"}`);
    return 0;
  }

  if (command === "grant") {
    const operationId = requireOperationId(options);
    const userId = requireText(options, "userId");
    const reason = requireReason(options);
    const amountMicroPoints = pointsToMicroPoints(options.points);
    if (amountMicroPoints <= 0) fail("--points must be greater than zero for a grant");
    const result = await operatorRequest(session, "/v1/operator/ai/balance", {
      method: "POST",
      body: { operationId, userId, amountMicroPoints, reason },
    });
    print(values.json ? JSON.stringify(result) : `${describeAccount(result.account)}\n${result.replayed ? "already applied" : `granted ${formatPoints(amountMicroPoints)} points`}`);
    return 0;
  }

  if (command === "requests") {
    const userId = requireText(options, "userId");
    const cursor = typeof options.cursor === "string" && options.cursor !== "" ? `&cursor=${encodeURIComponent(options.cursor)}` : "";
    const result = await operatorRequest(session, `/v1/operator/ai/requests?userId=${encodeURIComponent(userId)}${cursor}`);
    if (values.json) {
      print(JSON.stringify(result));
      return 0;
    }
    print(result.requests.length === 0 ? "no requests" : result.requests.map(describeRequest).join("\n"));
    if (result.nextCursor !== null) print(`next cursor: ${result.nextCursor}`);
    return 0;
  }

  if (command === "settle") {
    const operationId = requireOperationId(options);
    const requestId = requireText(options, "requestId");
    if (!UUID.test(requestId)) fail("--request-id must be a UUID");
    const reason = requireReason(options);
    const chargedMicroPoints = pointsToMicroPoints(options.points);
    const result = await operatorRequest(session, `/v1/operator/ai/requests/${encodeURIComponent(requestId)}/settle`, {
      method: "POST",
      body: { operationId, chargedMicroPoints, reason },
    });
    print(values.json ? JSON.stringify(result) : `${describeRequest(result.request)}\n${result.replayed ? "already settled" : "settled"}`);
    return 0;
  }

  fail(`unknown command ${JSON.stringify(command)}; run --help`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await run();
  } catch (error) {
    const message = error instanceof CliError
      ? error.message
      : error instanceof ControlPlaneError
        ? `${error.code}${error.status ? ` (HTTP ${error.status})` : ""}`
        : "unexpected failure";
    process.stderr.write(`account-ai-admin: ${message}\n`);
    process.exitCode = 1;
  }
}
