# Verifying the product account end to end

`node scripts/verify-product-account.mjs` runs the real app against the real
account Worker in one disposable place. It needs no operator domain, Cloudflare
account, model key or Cloud account.

```sh
node scripts/verify-product-account.mjs                      # this checkout's Electron, emailed codes
node scripts/verify-product-account.mjs --app "/Applications/Hezuo Product.app"
node scripts/verify-product-account.mjs --app "…/Hezuo Product.app" --bundled-trust
node scripts/verify-product-account.mjs --keep               # keep the disposable profile
node scripts/verify-product-account.mjs --password           # password form, no mail transport
```

`--bundled-trust` proves the shipped trust path rather than a process-wide one.
It copies the given `--app` bundle to the run's disposable root, writes a
version-2 `product-service.json` into the copy naming the fixture Worker's
origin and its public certificate, and launches that copy with no
`NODE_EXTRA_CA_CERTS` and no other trust injection. Sign-in, the account client
and model inference then verify the Worker exactly as a real installation
verifies its operator's gateway. Only a macOS bundle can be copied this way, so
the flag requires both `--app` and macOS.

`--password` runs the same app against a Worker deployed with
`AUTH_EMAIL_VERIFICATION=off` and no `EMAIL` binding: the gate's own
create-account and sign-in forms are driven instead of the emailed-code tab,
`/v1/auth/methods` reports `emailCode.enabled: false`, and the operator's
lookup still finds the (unconfirmed) account because that deployment's policy
does not gate on confirmation. The default run keeps the emailed-code route.

The first form builds `gateway/control-plane/src/index.ts` with esbuild and
runs it under the Miniflare that the control-plane's pinned Wrangler ships, over
TLS on `127.0.0.1` with a self-signed certificate. It applies this checkout's
migrations to a fresh D1 database, sends its one-time codes through the Worker's
real `EMAIL` binding (a disposable mailbox), and reaches a loopback upstream
through the Worker's own egress. The desktop app is the real
`desktop/electron/main.mjs`, started with its explicit fixture entry
(`OMB_PRODUCT_FIXTURE=1` and `--omb-product-fixture-root=`), so its product gate,
account window, workspace window, server child and product AI provider are the
production ones.

The fixture deployment has mail, so the account form offers both a password and
the emailed sign-in code it starts with; `AUTH_EMAIL_VERIFICATION=off` covers
the no-mail path in the Worker suite instead. The script signs in with an
emailed code, reads `pending`, signs in as the
operator's own session to restart the Worker with that user id in
`AI_OPERATOR_USER_IDS` (`/v1/me` → the documented bootstrap), enables the
account and grants 1 point (1,000,000 micro-points) through
`/v1/operator/ai/*`, refreshes the app to
`ready`, sends `你好`, and checks the Worker's ledger for one metered request at
the fixture's exact price. It then adds a stdio MCP server that writes one file,
proves the file is absent at the approval card, allows it, and reads back
`verified`; denials write nothing. A second account signs in, sees its own empty
workspace with an insufficient balance, cannot reach the upstream, and signing
back in as the first account restores its history. Screenshots (always kept
under the run's `evidence` directory) are taken at 1440×900, 1000×800 and
390×844. The script checks overflow, unobscured input, fixed sidebar widths,
the docked third column, the medium-width overlay, and the phone drawer's
Escape/close-button behavior with focus return.

Account switching transfers Electron's local-server ownership to the active
partition, removes the previous partition's owner header, and blocks that old
partition from the server. Final sign-out revokes model tokens and deletes the
encrypted login record while retaining the two separate workspace roots.

The fixture does not start or attach a desktop-control daemon. Computer access
stays unavailable because this disposable app has not been granted permission;
the MCP file tool exercises approval without using the user's desktop.

The app is launched with `--use-mock-keychain` on macOS: the fixture's HOME is
disposable, so there is no login keychain to unlock. `safeStorage` and the
encrypted record store still run for real, but the operating system's own
keychain permission prompt is not part of what this recipe proves.

The JSON receipt lists every step, the account bridge state at each milestone
(no token ever), the balance before and after, the ledger rows, the artifact
contents, screenshot paths, and the app's exit. A failed run also records the
last account state, whether the login record was written, and the app's log
tail.

## Product prompt and tool budget

Managed desktop requests default to the existing tool-discovery bridge. Core and permission-sensitive outbound tools stay advertised; other enabled capabilities are discovered through `find_tool` and loaded with their exact schema when needed. Explicit tool selections and engine permission policies still disable bridging when names must remain visible. The operator's explicit `OMB_AGENTS_TOOL_BRIDGE=0` remains authoritative.

Product prompts omit the developer skill-authoring paragraph and replace the long credential, automation, profile and shell guidance with compact product instructions. Custom standing instructions, active task context, security boundaries and enabled computer/browser instructions remain intact. The system-prompt preview includes a byte count and a per-section `approxTokens` value.

`desktop/server/prompt-token-breakdown.ts` provides per-section and per-tool byte counts with `approxTokens = ceil(UTF-8 bytes / 4)`. This is an estimate, not the model's tokenizer; history and provider framing add input tokens. The helper returns identifiers and counts only, never raw prompts or credentials. For a before/after comparison, call it with the full prompt/catalog and then the product prompt/discovery catalog from the same isolated bot settings. Include every row, not only totals. The compact-prompt regression lives in `system-prompt.test.ts`; bridge defaults and permission exclusions live in `agents-bridge-switch.test.ts`.

Only a gateway ledger entry for a new default bot's `你好` request can prove the 8,000-input-token acceptance limit. Record its request ID, measured input usage and the corresponding before/after estimated tables; a passing synthetic upstream fixture does not establish the real provider's token count.

Set `OMB_REQUEST_TOKEN_DIAGNOSTICS=1` on the Electron main process to emit
`[request-token-diagnostics]` from the actual inference dispatch. The opt-in
report counts system messages, history, every serialized tool, framing and
parameters; it excludes quote requests and never prints prompt content or
headers. The existing account fixture's environment allowlist does not forward
this variable, so setting it on that verifier alone does not enable diagnostics.
The loopback transport regression checks total bytes against the received body.

On 2026-11-13, an isolated TokenProbe reconstruction estimated 17,998 tokens
before and 7,554 after for prompt sections plus the agents catalog. The full
per-section/per-tool count output was saved to `/tmp/hezuo-beta-token-breakdown.json`.
Both are UTF-8/4 estimates, not captured old/new product requests; other MCP
definitions, history and framing are excluded. This does not establish the
8,000-token requirement, which remains pending real gateway usage.



### Isolated reconstructed breakdown (estimated tokens)

| Kind / identifier | Before | After |
| --- | ---: | ---: |
| sections / `persona` | 11 | 11 |
| sections / `shell` | 273 | 52 |
| sections / `browser` | 1040 | 1040 |
| sections / `coordination` | 613 | 613 |
| sections / `credential` | 257 | 42 |
| sections / `routine` | 842 | 76 |
| sections / `profile` | 253 | 57 |
| sections / `team-memory` | 72 | 72 |
| sections / `availability` | 12 | 12 |
| sections / `memory` | 579 | 579 |
| sections / `reply-habits` | 714 | 714 |
| sections / `learn` | 190 | 0 |
| sections / `tool-bridge` | 0 | 147 |
| tools / `execution_connector` | 147 | 0 |
| tools / `tool_result_read` | 206 | 206 |
| tools / `list_room_targets` | 115 | 115 |
| tools / `coordinate_bots` | 948 | 948 |
| tools / `assignment_status` | 268 | 0 |
| tools / `list_bots` | 101 | 101 |
| tools / `usage_limits` | 88 | 0 |
| tools / `list_rooms` | 136 | 136 |
| tools / `select_computer` | 300 | 300 |
| tools / `list_threads` | 183 | 0 |
| tools / `close_thread` | 180 | 0 |
| tools / `start_thread` | 500 | 0 |
| tools / `vm_exec` | 232 | 0 |
| tools / `attach_file` | 282 | 282 |
| tools / `show_widget` | 712 | 0 |
| tools / `show_html` | 605 | 0 |
| tools / `publish_page` | 203 | 203 |
| tools / `unpublish_page` | 96 | 0 |
| tools / `post_to_room` | 270 | 270 |
| tools / `request_credential` | 269 | 269 |
| tools / `request_sign_in` | 244 | 244 |
| tools / `fill_login` | 198 | 198 |
| tools / `decide` | 156 | 0 |
| tools / `extract` | 142 | 0 |
| tools / `report_bug` | 146 | 0 |
| tools / `memory_update` | 454 | 454 |
| tools / `memory_log` | 169 | 0 |
| tools / `session_search` | 489 | 0 |
| tools / `trigger_info` | 376 | 0 |
| tools / `trigger` | 2020 | 0 |
| tools / `delete_trigger` | 125 | 0 |
| tools / `wait_until` | 268 | 0 |
| tools / `list_waits` | 85 | 0 |
| tools / `cancel_wait` | 58 | 0 |
| tools / `propose_profile` | 432 | 0 |
| tools / `propose_model` | 377 | 0 |
| tools / `propose_team_memory` | 221 | 0 |
| tools / `skills_list` | 108 | 0 |
| tools / `skill_manage` | 597 | 0 |
| tools / `mcp_server` | 636 | 0 |
| tools / `find_tool` | 0 | 235 |
| tools / `use_tool` | 0 | 178 |
| **Total** | **17998** | **7554** |

Zero means omitted from that reconstructed request, not an unavailable capability.

## What it does not prove

* No operator-owned public domain, Cloudflare deployment, or real upstream
  provider is contacted; the Worker runs locally with a loopback upstream.
* No payment, subscription or purchase page exists to test.
* Windows and Linux packaging are not exercised by a macOS run.
* The certificate is a throwaway self-signed one. In the default run this
  process and the app it launches trust it through `NODE_EXTRA_CA_CERTS`, which
  is not an OS install; `--bundled-trust` instead proves the packaged path,
  where the app carries the certificate in its own resource and reads no trust
  from the environment.
* The OS keychain is Electron's mock under the disposable HOME; real keychain
  unlock and prompts are verified separately.
* The fixture reports how Electron exits. A receipt with `SIGKILL` means its
  bounded cleanup forced termination; it does not prove graceful app shutdown.
