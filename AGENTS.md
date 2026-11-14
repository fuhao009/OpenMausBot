# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

## Desktop Bot and real-model verification

The managed Hezuo Bot uses the project's `product-ai` account gateway, not a
Codex CLI login. Read `docs/gateway-deployment-193.md` before diagnosing model
availability or testing the Bot. The deployed gateway has database-managed
model channels in `ai_channel_catalog`; empty model fields in `gateway.json`
or `ai: false` in `gateway-runtime.json` do not establish that AI is unavailable.
Check the account's available models and the Bot/conversation's actual selection.
Never print or copy model credentials during diagnosis.

For model-driven browser acceptance, send natural-language requirements to the
project Bot and record its actual model, Bot name, each action, elapsed time,
and independently observed page result. Direct scripted tool calls and fake
model responses are not evidence of real-model task completion.

## Comments

Write a comment only for what the code cannot say:

- a license or attribution notice;
- a fact forced by something outside this code (a vendor, CLI, OS, browser,
  Electron or protocol behaviour), with its version when it has one;
- the doc comment of a public contract: the wire types in `packages/shared/`, the
  driver interface, the preload bridge, `config.json` fields people edit;
- a link to an upstream issue;
- a security invariant or a known open risk.

Do not narrate what the next line does, restate a name, record history ("used
to", "no longer", PR or issue numbers, plan or slice names: git has it), point
at other files, draw banners or leave commented-out code. When our own code
needs a paragraph to explain a surprise, change the code instead: a better
name, a type, an extracted function, one shared helper. A rule ("never X",
"must match Y") belongs in a type, a test or a lint rule. Never suppress a lint
rule that guards correctness; fix the code.

More specific `AGENTS.md` files override this note within their directories.

## Local toolchain

On this machine `~/.local/bin/node` is a broken link. Put
`~/.local/nodejs/node-v24.16.0-darwin-arm64/bin` first on `PATH` before running
`pnpm`. `pnpm typecheck` and `pnpm lint` already fail at HEAD in `desktop/companion/`,
`desktop/electron/gateway-companion-tunnel.mjs` and `gateway/local/local-gateway/`; check
`npx tsc -b` and `npx oxlint --deny-warnings src` for front-end changes.

Fetching from GitHub over HTTPS fails here with an HTTP/2 framing error. Go through
the local proxy over HTTP/1.1, per command, without changing git config:
`git -c http.proxy=http://127.0.0.1:7890 -c http.version=HTTP/1.1 fetch personal`.
Unset the proxy variables for anything that talks to the LAN gateway at 192.168.66.193.

Desktop work, integration with the gateway and product packaging all happen in this
directory on `feat/bot-panel-unify`; merge `backend/gateway-beta` here rather than in a
separate integration worktree. The 193 product build needs
`--lan-origin --gateway-ca <pem>`, and `electron-builder` is only on `PATH` when run
through `pnpm` (or with `node_modules/.bin` added).

## Working with the owner

When anything blocks or stalls (a conflict needing a decision, a failing build or
test, a network or credential problem, a drag that lands in the wrong place),
stop and tell the owner at once. Do not work around it on your own.
