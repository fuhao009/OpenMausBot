// The operator CLI has to be usable by a person who has a password and no mail
// transport: a deployment whose `/v1/auth/methods` says `emailCode.enabled:
// false` must ask for the password, not for a code that can never arrive. The
// password is read without echo and never becomes an argument.
import { describe, expect, it } from "vitest";

import { ControlPlaneError } from "../electron/control-plane-client.mjs";
import { askHidden, run, signedInOperator } from "./account-ai-admin.mjs";

/** A terminal double: `askHidden` needs isTTY, setRawMode, on/off/resume/pause,
 * and a way to push keystrokes. Keys typed before the prompt subscribes are
 * queued and delivered on subscription, so a test never races the sign-in. */
function terminal() {
  const listeners = new Set();
  const pending = [];
  const written = [];
  const deliver = (buffer) => {
    for (const listener of listeners) listener(buffer);
  };
  const input = {
    isTTY: true,
    raw: false,
    setRawMode(value) { this.raw = value; },
    resume() {},
    pause() {},
    on(event, listener) {
      if (event !== "data") return;
      listeners.add(listener);
      for (const buffer of pending.splice(0)) deliver(buffer);
    },
    off(event, listener) { if (event === "data") listeners.delete(listener); },
  };
  const output = { write(chunk) { written.push(chunk); return true; } };
  const type = async (text) => {
    const buffer = Buffer.from(text, "utf8");
    if (listeners.size === 0) pending.push(buffer);
    else deliver(buffer);
    // `askHidden` resolves on the newline; give it a turn.
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { input, output, written, type };
}

function methods({ emailCode }) {
  return { password: { enabled: true, minLength: 10, maxLength: 128 }, emailCode: { enabled: emailCode }, emailVerification: emailCode ? "required" : "off" };
}

function clientStub({ methodResults }) {
  const calls = [];
  return {
    calls,
    origin: "https://gateway.test",
    async authMethods() { calls.push(["authMethods"]); return methods(methodResults); },
    async signInWithPassword(email, password) {
      calls.push(["signInWithPassword", email, password]);
      return { accountToken: "t".repeat(32), user: { id: "user-1", email } };
    },
    async requestOTP(email) { calls.push(["requestOTP", email]); },
    async verifyOTP(email, code) {
      calls.push(["verifyOTP", email, code]);
      return { accountToken: "t".repeat(32), user: { id: "user-1", email } };
    },
    async me() { return { id: "user-1", email: "op@example.com" }; },
  };
}

describe("askHidden", () => {
  it("masks every character and returns the typed secret", async () => {
    const tty = terminal();
    const answer = askHidden("Password: ", tty.input, tty.output, { mask: "[\\s\\S]", maximum: 256 });
    await tty.type("hunter2");
    await tty.type("\r");
    await expect(answer).resolves.toBe("hunter2");
    expect(tty.written.join("")).toBe("Password: *******\n");
    expect(tty.input.raw).toBe(false);
  });

  it("handles backspace and refuses a non-terminal instead of echoing", async () => {
    const tty = terminal();
    const answer = askHidden("Verification code: ", tty.input, tty.output, { mask: "[0-9]", maximum: 8 });
    // "x" is not a digit and is never added; the backspace then removes the 5.
    await tty.type("1234x5");
    await tty.type("\u007f");
    await tty.type("6\n");
    await expect(answer).resolves.toBe("12346");

    await expect(askHidden("Password: ", { isTTY: false }, tty.output)).rejects.toThrow(/interactive terminal/);
  });
});

describe("signedInOperator", () => {
  it("uses the password form when the deployment has no emailed codes", async () => {
    const tty = terminal();
    const io = { stdin: tty.input, stdout: tty.output, stderr: tty.output };
    const client = clientStub({ methodResults: { emailCode: false } });
    const session = signedInOperator({ origin: "https://gateway.test", operatorEmail: "Op@Example.com" }, io, { client, environment: {} });
    await tty.type("correct horse\n");
    await expect(session).resolves.toMatchObject({ token: "t".repeat(32), user: { email: "op@example.com" } });
    expect(client.calls).toEqual([
      ["authMethods"],
      ["signInWithPassword", "op@example.com", "correct horse"],
    ]);
    // No code was requested: there would be nothing to deliver.
    expect(client.calls.some(([name]) => name === "requestOTP")).toBe(false);
  });

  it("keeps the emailed code as the default where mail exists", async () => {
    const tty = terminal();
    const io = { stdin: tty.input, stdout: tty.output, stderr: tty.output };
    const client = clientStub({ methodResults: { emailCode: true } });
    const session = signedInOperator({ origin: "https://gateway.test", operatorEmail: "op@example.com" }, io, { client, environment: {} });
    await tty.type("12345678\n");
    await expect(session).resolves.toMatchObject({ token: "t".repeat(32) });
    expect(client.calls).toEqual([
      ["authMethods"],
      ["requestOTP", "op@example.com"],
      ["verifyOTP", "op@example.com", "12345678"],
    ]);
  });

  it("asks for a password with --password even where codes are available", async () => {
    const tty = terminal();
    const io = { stdin: tty.input, stdout: tty.output, stderr: tty.output };
    const client = clientStub({ methodResults: { emailCode: true } });
    const session = signedInOperator({ origin: "https://gateway.test", operatorEmail: "op@example.com", password: true }, io, { client, environment: {} });
    await tty.type("a long passphrase\n");
    await expect(session).resolves.toMatchObject({ token: "t".repeat(32) });
    expect(client.calls).toEqual([
      ["authMethods"],
      ["signInWithPassword", "op@example.com", "a long passphrase"],
    ]);
  });

  it("takes the password from the environment without prompting", async () => {
    const io = { stdin: process.stdin, stdout: { write() { return true; } }, stderr: { write() { return true; } } };
    const client = clientStub({ methodResults: { emailCode: false } });
    await expect(signedInOperator(
      { origin: "https://gateway.test", operatorEmail: "op@example.com" },
      io,
      { client, environment: { OMB_OPERATOR_PASSWORD: "from the environment" } },
    )).resolves.toMatchObject({ token: "t".repeat(32) });
    expect(client.calls).toEqual([
      ["authMethods"],
      ["signInWithPassword", "op@example.com", "from the environment"],
    ]);
  });

  it("falls back to an emailed code when a password is refused on a mail deployment", async () => {
    const tty = terminal();
    const written = [];
    const io = { stdin: tty.input, stdout: { write: (chunk) => { written.push(chunk); return true; } }, stderr: tty.output };
    const client = {
      origin: "https://gateway.test",
      async authMethods() { return methods({ emailCode: true }); },
      async signInWithPassword() { throw new ControlPlaneError("invalid_credentials", 401); },
      async requestOTP() {},
      async verifyOTP(email) { return { accountToken: "t".repeat(32), user: { id: "user-1", email } }; },
    };
    const session = signedInOperator({ origin: "https://gateway.test", operatorEmail: "op@example.com", password: true }, io, { client, environment: {} });
    await tty.type("wrong\n");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await tty.type("12345678\n");
    await expect(session).resolves.toMatchObject({ token: "t".repeat(32) });
    expect(written.join("")).toContain("asking for an emailed code instead");
  });

  it("never accepts a token from argv and prefers OMB_OPERATOR_TOKEN", async () => {
    const client = clientStub({ methodResults: { emailCode: true } });
    const io = { stdin: process.stdin, stdout: { write() { return true; } }, stderr: { write() { return true; } } };
    await expect(signedInOperator(
      { origin: "https://gateway.test" },
      io,
      { client, environment: { OMB_OPERATOR_TOKEN: "s".repeat(40) } },
    )).resolves.toMatchObject({ token: "s".repeat(40) });
    expect(client.calls).toEqual([]);
  });
});

describe("run argument handling", () => {
  it("refuses a password typed as an argument", async () => {
    const io = { stdout: { write() { return true; } }, stderr: { write() { return true; } } };
    await expect(run(["whoami", "--origin", "https://gateway.test", "--operator-email", "op@example.com", "--password", "secret"], io))
      .rejects.toThrow(/never taken as an argument/);
  });

  it("documents the password flag and the environment fallback", async () => {
    let help = "";
    await run(["--help"], { stdout: { write(chunk) { help += chunk; return true; } }, stderr: { write() { return true; } } });
    expect(help).toContain("--password");
    expect(help).toContain("OMB_OPERATOR_PASSWORD");
  });
});
