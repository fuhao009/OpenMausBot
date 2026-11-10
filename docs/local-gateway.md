# Running the gateway on this machine

`scripts/local-gateway.mjs` runs the **real** account Worker — the same code
and migrations `cloudflare/control-plane` deploys — on one machine, over TLS,
against a persistent database. Accounts, sign-in, operator permissions, model
tokens, the points ledger and the inference proxy are the production paths;
only the process around them belongs to this deployment.

```sh
node scripts/local-gateway.mjs init \
  --open-models ~/.omp/agent/models.yml \
  --default-model gpt-6-astra \
  --rate 1000000000 \
  --operator-id <your account id, after whoami>
node scripts/local-gateway.mjs start --config .omb-scratch/local-gateway/gateway.json
node scripts/local-gateway.mjs status --config .omb-scratch/local-gateway/gateway.json
node scripts/local-gateway.mjs stop  --config .omb-scratch/local-gateway/gateway.json
```

`init` writes `.omb-scratch/local-gateway/gateway.json` (mode 0600), which is
also the default `--config`. Nothing is committed and no secret is printed.

## What "persistent" means

| Piece | Where |
| --- | --- |
| D1 database (accounts, sessions, ledger, tokens) | `<data-dir>/state` (Miniflare's own D1 store) |
| Migration bookkeeping | the `d1_migrations` table, with Wrangler's exact schema and insert |
| Better Auth secret | `<data-dir>/secrets/better-auth-secret` (0600, created once) |
| Upstream key | `<data-dir>/secrets/upstream-key` (0600) or the OMP `models.yml` |
| SMTP submission URL | `<data-dir>/secrets/smtp-url` (0600) |
| TLS material | `<data-dir>/tls/` (generated) or `--cert`/`--key` |
| Run metadata (pid, origin, capabilities) | `<data-dir>/gateway-runtime.json` (0600, no secret) |

Restarting keeps every account, session, point balance and request row.
`migrate` applies pending migrations while the gateway is stopped; a running
`start` applies them on a throwaway runtime **before** it opens its listener,
so no request ever reaches a schema that is not yet migrated. Each migration
and its `d1_migrations` row are one `db.batch` transaction.

Because the table is Wrangler's own, `wrangler d1 migrations apply` against the
same D1 sees the same state: a migration this gateway applied is not re-run,
and one it has not applied still is.

When all migrations are already recorded, startup checks the migration table
without loading Wrangler's SQL parser. Pending migrations still use Wrangler's
parser and the same per-migration transaction. This avoids retaining the full
Wrangler module graph on ordinary gateway restarts; first-time setup still
loads it to apply the schema.

## Secrets

No secret is accepted on the command line and none is stored in the config.
`init` copies a value once from one of:

* a private file (`--smtp-file`, `--upstream-key-file`; regular file, mode 0600,
  never a symlink);
* the environment (`OMB_LOCAL_SMTP_URL`, `OMB_LOCAL_UPSTREAM_KEY`);
* the OMP `models.yml` named by `--open-models` (its provider `apiKey`), which
  is read again at `start` so exactly one copy exists.

Every secrets/config read is `O_NOFOLLOW` plus a regular-file and mode check,
and every write refuses an existing symlink. A config or secret file readable
by another account is rejected, never repaired.

The operator's own password is never stored: `whoami` reads
`OMB_LOCAL_OPERATOR_PASSWORD` for that one run, or falls back to an emailed
code. `--operator-email` is the only account-related argument it takes.

## Origin, TLS, and binding

* The origin is always HTTPS, and always includes the port:
  `https://127.0.0.1:8787` by default.
* Default bind is `127.0.0.1`. A non-loopback `--host` requires
  `--public-host`, so the origin clients pin is the one they can reach.
* Without `--cert`/`--key`, a self-signed certificate for the exact origin host
  is generated under `<data-dir>/tls/`. TLS verification is never disabled.

### Trusting the gateway certificate

A generated certificate is **not trusted by anything else by default**. Two
paths avoid importing it anywhere:

* **Bundle it in the app.** Package the product build with
  `--gateway-ca <data-dir>/tls/gateway-cert.pem` (required with
  `--local-origin`). The certificate is written into the bundled
  `product-service.json` (version 2) and is trusted for exactly that origin,
  beside the platform roots. Account sign-in, the account client and model
  inference all verify the gateway through it; hostname and chain checks stay
  on, redirects are refused, and nothing else on the machine changes. See
  [the product release](product-release.md#2-package-the-app).
* **Trust it for one CLI run.** `NODE_EXTRA_CA_CERTS` (or
  `trustGatewayCertificate()`) helps CLI clients such as the gateway's own
  `whoami`, `scripts/account-ai-admin.mjs` and smoke scripts. Nothing in the
  Electron process reads it for its own network stack.

An app built without `--gateway-ca` needs the certificate in the operating
system's trust store before it can reach the gateway:

* **macOS**: add `gateway-cert.pem` to the login keychain as a trusted root
  (`security add-trusted-cert`), or ship a CA-issued certificate for a name the
  machine resolves.
* **Windows**: install it under *Trusted Root Certification Authorities*.
* **Linux**: copy it to `/usr/local/share/ca-certificates/` and run
  `update-ca-certificates`.

Until one of those steps is done, the app fails closed with a TLS error against
the gateway — expected, and not a bug in either side. There is no configuration
in this repository that silences the check.

* The renderer never chooses the origin: a packaged app reads one pinned origin
  from its bundled `product-service.json`. Packaging that origin needs
  `--local-origin` (`scripts/package-product.mjs`), the only path that
  accepts a loopback origin, and `--gateway-ca` alongside it.

## Models and points

* `--models <file>` takes a catalog in the Worker's own `AI_MODELS` shape and
  honours each entry's `enabled` flag (an operator's explicit decision).
* `--open-models <file>` mirrors an OMP `models.yml`. **Mirrored models are
  disabled unless the chosen model has explicit rates**, and only
  `--default-model` (one model) is published; the rest of the provider's models
  never become billable or selectable by mirroring alone.
* `--rate 1000000000` is 1,000 points per million tokens for input, cached
  input and output. `--rates` gives per-model rates:
  `{"gpt-6-astra":{"inputMicroPointsPerMillion":1000000000,…}}`.
* One point is 1,000,000 micro-points. Rates are micro-points per million
  tokens. Absent rates mean disabled: there is no default price and no free
  path.
* `--max-output-tokens` (default 1024) only ever lowers a model's own limit, so
  the worst-case reservation stays bounded.

## Sign-in mail

The Worker calls its `EMAIL` binding exactly as on Cloudflare
(`send({to, from:{email,name}, subject, html, text})`). The gateway binds a real
Worker entrypoint that forwards the Worker's own message to this process over a
fetch service binding, and only this process holds the SMTP URL. There is no
file or mock mailbox outside the explicit fixture.

* `--email-from` + `--smtp-file` enable emailed codes; the submission URL is
  `smtps://user:pass@host:465` or `smtp://user:pass@host:587` (STARTTLS is
  required for the plain scheme, and credentials are only sent after it).
* `--email-verification required|off` is independent of that: `required` needs
  mail and is refused without it; `off` never asks for a code. The default is
  `required` when mail is configured and `off` otherwise.
* The worker never logs an address, code, or body; the SMTP adapter returns a
  stable error code only.
* A private SMTP CA (a relay with its own certificate) is trusted per
  connection with `OMB_LOCAL_SMTP_CA=<ca.pem>`; verification stays on.

The full path was proven against a local TLS relay: sign-up with verification
`required` issues no session, the Worker's own message arrives over SMTP with
both text and HTML parts, the extracted code verifies the address, password
sign-in then succeeds, and replaying the code is refused (`invalid_otp`). The
account reads `pending` with zero points.

## Upstream

Inference goes to exactly one operator-configured HTTPS base
(`--upstream-base`, or the mirrored provider's `baseUrl`) on
`/chat/completions` and `/responses`. The Worker's own headers travel
(`accept`, `accept-encoding`, `authorization`, `content-type`); platform
metadata such as `host`/`cf-worker` is never replayed. Redirects are returned
to the Worker, never followed, and a transport failure becomes
`502 upstream_error` (which the Worker records as a reviewable reservation
instead of a silent success).

## Running it as a login service (macOS)

`start` runs in the foreground and dies with its terminal. For a gateway that
comes back at login, install it as a LaunchAgent:

```sh
node scripts/local-gateway.mjs service install \
  --config "$HOME/Library/ApplicationSupport/HezuoGateway/gateway.json"
node scripts/local-gateway.mjs service status  --config <same file>
node scripts/local-gateway.mjs service uninstall --config <same file>
```

What the installed job uses:

| Piece | Where |
| --- | --- |
| LaunchAgent | `~/Library/LaunchAgents/com.openmausbot.gateway.plist` (0600) |
| Node it runs | `<data-dir>/service/node` — an APFS clone (`cp -c`), not `/tmp` |
| Log | `<data-dir>/logs/gateway.log` (0600, bounded — see below) |
| Service command | the same `node <checkout>/scripts/local-gateway.mjs start --config …` |

The plist carries **paths only**: no key, token, password, or SMTP
credential. Secrets keep living in `<data-dir>/secrets/` (0600) and are read by
the gateway at start, exactly as in the foreground.

* `--node <file>` stages a different Node (any 24 or newer). Without it, a
  per-user runtime Node, Homebrew, `/usr/local`, then the running executable
  are tried in that order; the one chosen is copied and verified by running
  `--version` on the copy. Because it is a copy, a Node in `/tmp` or in an npm
  cache is acceptable as the *source* — the job never points at it.
* `RunAtLoad` starts it at login; `KeepAlive`/`SuccessfulExit=false` restarts
  it only after an unclean exit, so `service uninstall` (or `bootout`) stops it
  for good. `ThrottleInterval` is 10s, so a crash loop cannot spin.
* The log is opened by launchd, which never reopens it and never rotates it.
  The gateway therefore trims it in place once it exceeds 8 MiB, keeping the
  last 512 KiB from a line boundary (`scripts/local-gateway/log-bounding.mjs`).
  `Umask 63` plus a pre-created file keep it 0600.
* `Umask` and `WorkingDirectory` are the data directory, so a relative path
  never resolves somewhere unexpected.

`service install` **refuses while a gateway started by hand is running** for
that config: stop it first, then install. Nothing is changed by the refusal.
Re-running it is also how the job is upgraded: the gateway the job already
owns is replaced, not treated as a conflict. Two commands also refuse rather
than fight launchd — `stop` (the job would restart the gateway) and, because of
that, any supervisor that expects `stop` to end the process. Use
`service uninstall` for a job, `stop` for a foreground gateway.

To upgrade after editing the gateway, run `service install` again; it stops the
old job, replaces the plist and the Node copy, and starts the new one. The job
runs the checkout's own `scripts/local-gateway.mjs`, so it picks up whatever
that path holds at the next start — run `service install` after a move.

`service install` waits (up to three minutes) for the gateway to publish its
runtime metadata, so its `ready` field is measured, not assumed — the first
start on a cold database bundles the Worker and runs every migration before it
says anything, which took 35 s here on an idle machine, and launchd's log file
stays empty until the process flushes its first line. A timeout answers
`ready: false, stillStarting: true`: the job **is** installed, and
`service status` then says whether it is still starting or has stopped.

`status` distinguishes three states that look alike in `launchctl`:

* `running: true` — the gateway answered, and `healthy` is its own `/healthz`;
* `starting: true` — the launchd job is loaded but has not published
  `gateway-runtime.json` yet (a first start spends a few seconds on
  migrations), so a `null` runtime there is expected, not a failure;
* neither — there is no job and no process.

`service uninstall` removes the LaunchAgent and the staged Node. Accounts,
sessions, secrets, logs and the database are untouched.

## Choosing the operator (who is allowed to administer AI)

No account becomes an operator automatically: the first sign-up is still
`pending` with zero points, exactly as on Cloudflare. There are two explicit
ways to name the operator's account id.

**Online** (needs the gateway running and that account's password or code):

```sh
node scripts/local-gateway.mjs whoami --config <config> --operator-email you@example.com
node scripts/local-gateway.mjs init   --config <config> --operator-id <id>
```

**Offline, by exact registered address** (reads the D1 store read-only; it does
not need the gateway running, and it does not disturb it):

```sh
node scripts/local-gateway.mjs operator --config <config> --operator-email you@example.com
# then restart whatever runs the gateway so the new list is read:
node scripts/local-gateway.mjs service install --config <config>   # launchd job
# or: stop, then start, for a foreground gateway
```

`operator` looks the address up in this data directory's own database, prints
the account id and its current AI state, and writes only `operatorIds` in the
config. It never creates an account, never invents an address, and never opens
AI permission or grants points:

* an address with no account is refused, listing nothing and changing nothing;
* an address present in two database files is refused rather than guessed;
* `--remove` takes the id back out of the list.

Enabling AI and granting balance remain separate, explicit calls to
`scripts/account-ai-admin.mjs` (`enable`, then `grant`), as in the hosted
deployment. That CLI signs in with `OMB_OPERATOR_TOKEN` when set, otherwise an
account **password** (non-echoing prompt, or `OMB_OPERATOR_PASSWORD` for
unattended runs; never an argument), otherwise an emailed code. A deployment
without mail answers `emailCode.enabled: false`, so the password form is chosen
without needing `--password`.

## First run

1. `init` (no operator id yet), then `start` (or `service install`).
2. Sign up with an email/password, or ask for an emailed code.
3. Name the operator explicitly: `operator --operator-email you@example.com`
   (offline, needs the gateway stopped) or `whoami --operator-email …` plus
   `init --operator-id <id>` (online). Both print the account id.
4. `enable`, then `grant` through `scripts/account-ai-admin.mjs` — the same CLI
   the hosted deployment uses. Sign-ups start `pending` with zero points and
   no grant happens automatically.

## Verification

```sh
node scripts/local-gateway.mjs init --config /tmp/gw/gateway.json \
  --open-models ~/.omp/agent/models.yml --default-model gpt-6-astra \
  --rate 1000000000 --port 8901
node scripts/local-gateway.mjs start --config /tmp/gw/gateway.json &
node scripts/local-gateway.mjs status --config /tmp/gw/gateway.json
node scripts/local-gateway.mjs migrate --config /tmp/gw/gateway.json
node scripts/local-gateway.mjs stop --config /tmp/gw/gateway.json
```

Programmatic supervision uses the same code:

```js
import { startLocalGateway, readGatewayConfig, trustGatewayCertificate } from "./scripts/local-gateway.mjs";
const { config } = readGatewayConfig("/tmp/gw/gateway.json");
const gateway = await startLocalGateway({ config, configPath: "/tmp/gw/gateway.json" });
trustGatewayCertificate(gateway.certificate);
// gateway.origin, gateway.capabilities, gateway.db(), gateway.runScheduled()
await gateway.close(); // idempotent; returns after Miniflare shut down
```

The local gateway runs the Worker's scheduled maintenance before reporting
readiness, then once per minute without overlapping runs. Failed periodic
runs are logged and retried on the next interval; shutdown clears the timer
and waits for an active run. Stale AI reservations move to review and stop
occupying active-request slots. Their reserved points remain held for usage
reconciliation; maintenance does not refund unknown usage.

`status` reports `running`, `healthy`, the origin, capabilities and migration
counts — never a secret. Programmatic callers reach the gateway with
`trustGatewayCertificate()` (or an `https.request` carrying the CA); the
desktop app verifies it through the certificate bundled at package time (or,
for an app built without `--gateway-ca`, through the OS trust store), as
described above. `stop` signals only a process whose recorded config
path and command line match, so a reused PID cannot kill an unrelated process.

## Offline gateway identity cutover

The `identity-migrate` command moves an existing stopped installation to a
`HezuoGateway` directory. It does not install, stop or start a service. D1 retains
its historical persistence identity internally: do not replace that identity or
export/import only selected tables. The entire state tree (including SQLite WAL
files), credentials, authentication secret and TLS material moves together.
The origin remains `https://127.0.0.1:18487` for the standard installation.

1. Quit all desktop clients and stop manual gateway processes. Disable external
   supervisors. Using the **old checkout**, run `service uninstall --config`
   with the actual old config path. This boots out its old LaunchAgent and
   removes the installed plist. Do not merely kill its PID: launchd may restart
   it. Retire any already-installed new gateway service as well. Keep both
   checkouts stopped throughout the move.
2. Make an offline, private backup of the complete data directory. Identify the
   actual configured directory rather than assuming a documented example path.
   Keep the backup offline; never run old and new copies concurrently. The
   config must be inside the data directory. The destination must not exist and
   must be on the same filesystem; no merging or cross-volume copy is attempted.
3. From the new checkout run (substitute your actual source config):

   ```sh
   node scripts/local-gateway.mjs identity-migrate \
     --config "/actual/old/data/gateway.json" \
     --data-dir "$HOME/Library/Application Support/HezuoGateway"
   ```

   This refuses loaded/installed services, a live recorded PID, or an occupied
   listening port. It preserves config values, rewriting only owned absolute
   file paths below the moved directory. External files remain external. It
   never calls `init`, generates certificates, rotates secrets, or prints their
   contents. Unexpected service-query failures stop the operation. Keep other
   writers disabled: these checks are not a lock against an operator starting
   an old checkout during migration.
4. Run `service install --config` with the returned config path and a suitable
   `--node` when needed. This regenerates all launch paths under the new label
   `com.hezuo.gateway`; stale staged plists inside the moved tree are inert and
   must not be installed manually. Check `status`, sign in with an existing
   account, and confirm history, balance and credentials before deleting your
   backup. Do not change the origin or regenerate the trusted certificate.

If installation fails, leave both services stopped and retain the moved tree.
Correct the installation and retry; do not initialize a blank database. For
rollback, uninstall the new service first and restore the complete offline
backup and old checkout together before reinstalling the old service. Never
restore only the config or run the backup as a second gateway.

