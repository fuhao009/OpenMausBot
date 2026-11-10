# Terminal setup

Install [Node.js](https://nodejs.org/) 24 or newer, then choose either way to run Hezuo:

```sh
# Install once, then use the short command:
npm install -g hezuo
hezuo
```

Or, without a global install:

```sh
npx hezuo
```

Use the same command next time. The first launch guides you through setup; later launches reuse your saved AI connection and phone-access choice. `hezuo start` is the same as the bare command. If that workspace is already running, Hezuo opens it instead of starting a second server.

## First launch

The setup wizard uses Clack. Use ↑/↓ and Enter to select an option. Plain terminals show numbered choices instead.

1. Choose ChatGPT/Codex, Claude Code, or an API service. Existing supported connections are also listed.
2. Sign in with the provider, or paste an API key into the hidden prompt. Setup asks before installing a missing Codex or Claude CLI. Codex also offers device-code sign-in for a remote terminal. API choices include OpenAI, OpenRouter, Groq, and other OpenAI-compatible endpoints.
3. Choose a model and save. An API connection asks permission to send a short test message, which the provider may charge for. Native CLI setup confirms sign-in; it does not test the chosen model with a message. Model access is checked when you send one.
4. Optionally connect a phone, or choose **Skip for now**. Your AI setup is already saved before this step.

The workspace then starts and opens its local address in a browser on this computer. On SSH or a computer without a graphical desktop, open the printed address using an appropriate connection instead. Automatic browser opening only uses the local address; `--no-open` disables it.

Keep the terminal open while using your bots. This runs a foreground server, not an installed background service. Ctrl-C stops the server without deleting saved work; closing the browser alone does not stop it. Bots keep working only while the computer and server are running.

Codex and Claude Code support agent tools. API-key connections currently support chat only. A ChatGPT or Claude subscription does not include separately billed API usage. Changing the saved default affects **new bots only**; existing bots and conversations keep their settings.

## Optional phone access

A phone cannot connect to this computer's `localhost` address. Start the local
account gateway with `--host` and `--public-host` set to an address the phone
can reach, then sign in to the **same Hezuo account** on the phone app and on
this computer. After both sides are signed in, the phone is already connected
and can use companion features. No pairing code or QR code is required, and
this path does not use a Cloudflare tunnel or Tailscale.

This Hezuo account is separate from ChatGPT, Claude, or an API-provider
account. The connection stays active while Hezuo and the gateway are running.

Leftover pairing-code invitations can still be opened from a deep link, but
they are not the default way to connect a phone.


## Commands

The examples below assume a global install; prefix them with `npx` otherwise.

| Command | Use |
| --- | --- |
| `hezuo` | Set up once, then start with saved settings. |
| `hezuo setup` | Revisit AI and optional phone setup, save, and exit without starting. This is not a reset. |
| `hezuo --no-open` | Start without opening a browser. |
| `hezuo --local` | Ignore saved remote access for this launch; keep the saved choice for next time. |
| `hezuo --no-pair` | Suppress phone setup prompts and pairing invitations. This does **not** turn off saved remote access; use `--local` for that. |
| `hezuo pair` | Create another phone invitation while the configured workspace and HTTPS connection are running. |
| `hezuo sessions` | List paired devices; `hezuo sessions revoke ID` signs one out. |
| `hezuo serve` | Start without onboarding prompts or automatic browser opening; specify remote-access flags explicitly for a service. |
| `hezuo login` | Sign in to an Hezuo account for `--tunnel`; this does not sign in to an AI provider or start the tunnel. |

`start` accepts the same server options as `serve`, including `--port`, `--data-dir`, `--tailscale`, `--tunnel`, and `--public-url`. Keep using your custom data directory and port when starting or pairing:

```sh
hezuo setup --data-dir /path/to/omb-data --port 8799
hezuo --data-dir /path/to/omb-data --port 8799
```

Setup needs an interactive terminal. Later starts can run without one once setup is complete. Stop a running server before changing its setup or access mode: `--local` does not turn off a remote connection belonging to a server that is already running. You do not need to delete configuration, bots, or conversations to reconfigure it.

## Credentials and cancellation

API keys are hidden while typed or pasted. New API connections save their key in the data directory's `config.json` as **plaintext, not encrypted**, with owner-only permissions (`0600`) on Unix. Managed-access account credentials in `tunnel-account.json` are also plaintext with `0600` permissions on Unix. Keep these files and backups private. Native provider sign-in credentials are managed by the provider's own CLI.

Ctrl-C during AI setup leaves unsaved OMB changes unapplied. Installations and provider sign-ins already completed remain available. Ctrl-C during the later phone step keeps the AI setup you already saved, exits without starting a server, and does not undo an account sign-in already completed. Run `hezuo setup` to continue; no destructive reset is needed.

For remote access and background deployment options, see [self-hosting](self-hosting.md) and [the VPS guide](deploy-vps.md).
