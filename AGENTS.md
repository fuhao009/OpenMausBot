# OpenMausBot agent notes

Before claiming a server or conversation change works, follow
[`docs/verification/README.md`](docs/verification/README.md). Always launch an
isolated fixture; never verify mutations against the user's live app or data.

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
