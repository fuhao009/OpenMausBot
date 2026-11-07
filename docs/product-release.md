# Shipping Hezuo

Hezuo is the managed desktop product name and artifact prefix. Its application
ID and URL scheme remain `com.openmausbot.product` and `openmausbot-product`.
The desktop keeps `OpenMausBot Product` as its user-data directory so installing
`Hezuo.app` preserves existing account sessions and workspaces. Reinstallation
replaces the application bundle only, never the account directory or gateway.
The managed product is the same Electron application under its own release
identity: the operator runs the control-plane Worker and the model upstream,
users install the app and sign in with an email code, and the app's default
bot runs on the operator's account AI gateway. Nothing in this flow asks a
user for a model key, an engine CLI, or a service address.

Two scripts own it. Both refuse to run without an origin on a domain the
operator controls, and neither defaults to the upstream project's domains
(`openmausbot.com`, `mausbot.si`) or to a loopback address. Documentation
placeholders and fixture names (`.example`, `example.com`, `.invalid`,
`.test`, `.local`, IPs, loopback) are refused for a real deploy or build and
are accepted only by the compile-only dry runs; set `OPERATOR_ORIGIN` below to
the exact HTTPS origin you own, such as `https://ai.acme-ai.net`.

| Script | Does |
| --- | --- |
| `scripts/deploy-product-service.mjs` | deploys the Worker to the operator's Cloudflare account and D1 |
| `scripts/package-product.mjs` | builds the desktop installers against that origin |
| `scripts/local-gateway.mjs` | runs the same Worker locally instead of on Cloudflare |

The upstream `pnpm package:mac|win|linux` flows and `wrangler.jsonc` are
unchanged; the product build never ships from them.

A third way to run the same service exists for one machine instead of
Cloudflare: `scripts/local-gateway.mjs` runs this Worker over TLS on a
persistent local D1 with the operator's own SMTP and upstream. See
[the local gateway](local-gateway.md). Its origin is loopback, so packaging it
needs `--local-origin`, and a loopback certificate is trusted by no operating
system, so it also needs `--gateway-ca`.

On macOS the same script installs the gateway as a login service
(`service install|status|uninstall`), with a private Node copy and one bounded
0600 log, and names the operator by exact registered address without granting
anything (`operator --operator-email …`). Both are described in
[the local gateway](local-gateway.md).

The desktop product's bot list and docked work panel resize by dragging their
shared edges, without size buttons. Widths are remembered locally; the chat
retains at least 420px while resizing. Focus an edge and use Left/Right for
keyboard sizing; Escape during a drag restores its starting width. Narrow
screens retain the existing overlay drawers rather than draggable columns.

Managed workspaces present bots and tasks rather than execution models. Chat
headers, bot badges, team cards, bot creation/settings and account history do
not expose a model selector or model identity. Account balances and request
charges remain visible. The server-side catalog and execution contracts remain
unchanged; hiding model controls does not implement automatic team routing.
The managed sidebar omits its top-level add/new menu and inline add-bot rows.
Existing bots and conversations remain accessible; server-side bot and team
creation capabilities are unchanged.

The managed desktop uses a 280px default bot sidebar, a centered conversation
and pill composer, and an optional right details panel with Activity, Library
and Computer navigation. Existing width preferences and resizing remain active.
Apps and Settings use responsive 900px by 702px dialogs with 14px corners;
Settings uses a 198px section rail and separate Vault navigation. Execution
connector setup and task forms expand inside their cards, while pending
approvals remain visible. Account points and ledger errors remain explicit;
an unavailable balance is shown as a dash rather than zero.
Insufficient account credit is reported as insufficient points even when no
model credential was issued. A generic AI-unavailable message is not used for
that state. This does not release unknown-usage reservations: stale requests
must enter operator review and be settled through the audited ledger.
An authenticated operator can top up their own account from Account settings.
The desktop checks operator eligibility with the service, confirms explicitly,
and computes maximum headroom including held reservations in its main process.
No account bearer crosses the preload bridge. A grant is sent once with a unique
operation id; an uncertain response requires ledger review rather than an
automatic retry. Application points do not fund the upstream provider account.

## 1. Deploy the Worker

The deployment reuses the Worker entry point, migrations, and social-free
email-OTP authentication in `cloudflare/control-plane`, and turns tunnelling
off. It writes `cloudflare/control-plane/wrangler.product.generated.jsonc`
(gitignored, no secret values) naming the operator's own account, D1 route,
and sender. It never copies the upstream account IDs, zones, hostnames,
publisher, tunnel secrets, or model catalog.

Resources the operator must already own:

- an HTTPS hostname routed through Cloudflare, e.g. `ai.acme-ai.net`;
- a Cloudflare account and a D1 database created in it;
- Cloudflare Email Sending onboarded for the sender domain;
- a model upstream that speaks the OpenAI chat and/or Responses API, with a
  key, verified model limits, and operator-set prices in micro-points per million
  tokens (1 point = 1,000,000 micro-points).

Required environment:

| Name | Meaning |
| --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | 32-hex Cloudflare account id |
| `OMB_PRODUCT_SERVICE_URL` | exact HTTPS origin the app pins, e.g. `https://ai.<your-domain>` |
| `OMB_PRODUCT_D1_ID` | D1 database UUID |
| `EMAIL_FROM` | verified sender for emailed codes (required unless verification is off) |
| `AUTH_EMAIL_VERIFICATION` | `required` (default) or `off`; `off` deploys password accounts with no mail at all |
| `CLOUDFLARE_API_TOKEN` | Wrangler credential (real deploy only) |
| `BETTER_AUTH_SECRET` | at least 32 random characters (real deploy only) |

Password accounts always exist. `AUTH_EMAIL_VERIFICATION=required` (the
default with a sender) emails an 8-digit code that confirms a new account
before it signs in; `off` needs no sender and no `EMAIL` binding, and every
emailed-code route then answers `503 email_unavailable`. Where mail is
configured, the same code form also serves code-only sign-in and password
reset. Public sign-up starts with no AI permission and no balance; an operator
grants both.

Account AI is optional at first. Without `AI_UPSTREAM_BASE_URL`,
`AI_UPSTREAM_API_KEY`, `AI_DEFAULT_MODEL`, `AI_MODELS`, and
`AI_OPERATOR_USER_IDS`, accounts still sign in and read `unavailable`; no
request reaches an upstream. Supplying some but not all of them fails, so a
half-configured gateway never looks ready.

```sh
# Validate the generated config and bundle; uploads nothing.
CLOUDFLARE_ACCOUNT_ID=… OMB_PRODUCT_SERVICE_URL="$OPERATOR_ORIGIN" \
OMB_PRODUCT_D1_ID=… EMAIL_FROM=noreply@<your-domain> \
  pnpm product:deploy --dry-run

# No mail at all: password sign-up and sign-in only.
CLOUDFLARE_ACCOUNT_ID=… OMB_PRODUCT_SERVICE_URL="$OPERATOR_ORIGIN" \
OMB_PRODUCT_D1_ID=… AUTH_EMAIL_VERIFICATION=off \
  pnpm product:deploy --dry-run
```

Before those resources exist, `--dry-run --synthetic` fills the operator
resource names with reserved, non-routable placeholders
(`https://product.invalid`, zeroed IDs, a compile-only secret) so the Worker
bundle can be compiled and type-checked. It is rejected without `--dry-run`,
never uploads, and its summary is marked `"synthetic": true`; it cannot stand
in for a deployment.

The dry run prints the origin, Worker and database names, allowed origins,
model list, verification mode, and the required secret names. It prints no
secret value.

### Bootstrap order

1. Deploy with `AI_OPERATOR_USER_IDS='[]'` so no account can administer AI.
2. Sign in once with the operator CLI to learn your account ID:
   `node scripts/account-ai-admin.mjs whoami --origin "$OPERATOR_ORIGIN" --operator-email you@<your-domain>`
   (add `--password` for a password account; the password is prompted without
   echo, or read from `OMB_OPERATOR_PASSWORD` for an unattended run — it is
   never an argument. A deployment with no sender answers
   `emailCode.enabled: false`, and the CLI asks for the password by itself.)
3. Put that ID into `AI_OPERATOR_USER_IDS` and redeploy.
4. `lookup`, then `enable`, then `grant` each account with the same CLI.
   Every mutation needs a UUID `--operation-id` and a `--reason`; replays with
   the same ID and body are idempotent, different bodies conflict.

A real deploy applies pending D1 migrations and then uploads the Worker with
`BETTER_AUTH_SECRET` and (when account AI is configured) `AI_UPSTREAM_API_KEY`
in one call. Secrets are passed in a mode-0600 temporary file that is deleted
immediately; they never appear in argv, the generated config, the log, or the
printed summary.

```sh
CLOUDFLARE_ACCOUNT_ID=… OMB_PRODUCT_SERVICE_URL="$OPERATOR_ORIGIN" \
OMB_PRODUCT_D1_ID=… EMAIL_FROM=noreply@<your-domain> \
BETTER_AUTH_SECRET=… CLOUDFLARE_API_TOKEN=… \
AI_UPSTREAM_BASE_URL=https://models.<your-domain>/v1 \
AI_UPSTREAM_API_KEY=… AI_DEFAULT_MODEL=… AI_MODELS='[…]' \
AI_OPERATOR_USER_IDS='[]' \
  pnpm product:deploy
```

Verify `https://ai.acme-ai.net/healthz` answers `{"ok":true}` before
building the app. `/healthz` proves configuration only; it does not check
model capacity, upstream credentials, or mail delivery.

## 2. Package the app

For the local gateway the origin is loopback and must be passed explicitly,
together with the public certificate the app will verify:

```sh
OMB_PRODUCT_SERVICE_URL="https://127.0.0.1:18487" \
  pnpm product:package --platform mac --arch arm64 --dir --local-origin \
  --gateway-ca "$HOME/Library/ApplicationSupport/OpenMausBotGateway/tls/gateway-cert.pem"
```

`--local-origin` is the only flag that accepts a loopback origin; without it a
loopback address is refused exactly like any other non-public host. It requires
`--gateway-ca`, because a loopback certificate can never be publicly trusted
and the alternative — importing it into every client's trust store — is work
the bundle can do itself.

`--gateway-ca` names a PEM file holding **one public certificate**: either the
self-signed certificate a local gateway generates (it must name that origin's
host), or the CA root that issued the operator's certificate. A private key in
the file is refused, as are several certificates, surrounding text, an expired
certificate, or one for another host. The file is written into the bundled
resource as version 2 alongside the origin:

```json
{
  "version": 2,
  "origin": "https://127.0.0.1:18487",
  "ca": "-----BEGIN CERTIFICATE-----\n…\n-----END CERTIFICATE-----\n"
}
```

The app then trusts that certificate *in addition to* the platform roots and
only for that exact origin. Hostname and chain verification stay on, redirects
are refused, and no process-wide TLS setting changes, so nothing else on the
machine is affected and `NODE_EXTRA_CA_CERTS` is never consulted. `main` uses
it for the account client, and the account capability carries it to the local
runtime so model inference verifies the same origin; a renderer never sees it.
A certificate bundled for one origin is refused for another: the loader and the
runtime both bind `ca` to `origin` and fail closed on a mismatch.

Without `--gateway-ca` the resource stays at version 1 and the operator's
public certificate must already be trusted by the operating system, which is
the normal case for a public origin behind a CA-issued certificate.

```sh
# Isolated smoke build: an unpacked app directory.
OMB_PRODUCT_SERVICE_URL="$OPERATOR_ORIGIN" \
  pnpm product:package --platform mac --arch arm64 --dir

# Installers (DMG/zip on macOS, NSIS on Windows, AppImage/deb on Linux).
OMB_PRODUCT_SERVICE_URL="$OPERATOR_ORIGIN" \
  pnpm product:package --platform mac --arch arm64
```

`--dry-run` writes the generated config and bundled resource and builds
nothing. Both are regenerated on every run under
`.omb-scratch/product-release/<platform>-<arch>/` (already gitignored) and
contain no secret value — only the operator origin and build settings. A dry
run also accepts a reserved origin such as `https://product.invalid` so the
whole config can be checked before DNS exists; a real build refuses reserved
names, IPs, loopback, non-default ports, and the upstream project's domains.
`--unsigned` drops the macOS signing identity for local verification; it does
not produce a distributable that passes system checks.

The wrapper reads `electron-builder.yml` as the base so the verified server,
UI, companion, browser, CUA, DuckDB, Android tools, skills, and license
resources keep shipping exactly as before, then replaces the release identity:

| Setting | Value |
| --- | --- |
| `appId` | `com.openmausbot.product` |
| `productName` | `OpenMausBot Product` |
| artifacts | `OpenMausBot-Product-<version>-<arch>.<ext>` |
| protocol | `openmausbot-product` |
| `publish` | `null` at app, platform, and target level (no publisher, no update feed) |
| `extraMetadata` | `ombProductManaged: true`, product `desktopName` |
| output | `release/product/` |

It also writes `product-service.json` next to the app resources:

```json
{ "version": 1, "origin": "https://ai.acme-ai.net" }
```

With `--gateway-ca` the same file carries the origin's public certificate as
version 2 (`origin`, `ca`). That file is the only place a packaged app learns
its service address and trust anchor, and the main process ignores
`OMB_PRODUCT_SERVICE_URL` once packaged. Linux DEB hooks
and the AppArmor profile are regenerated from the checked-in files with the
product's own install root (`/opt/OpenMausBot Product`), executable
(`openmausbot-product`), launcher, profile name, and `.desktop` entry, so a
product install never repairs or removes the original app. `after-pack.mjs`
resolves the packaged `.app` from electron-builder's product filename instead
of assuming `OpenMausBot.app`.

Because a product build publishes nowhere (`publish: null`, not an empty
list, which still falls back to the repository field), no target writes
`app-update.yml`; the packaging hook also deletes any inherited GitHub feed
before signing, and the wrapper refuses a bundle that still has one. Tell
users the current version is provided by their administrator — the app does
not silently download the upstream build over the operator's.

The wrapper checks the finished app before reporting success: its packed
`package.json` must mark `ombProductManaged`, keep `electron/main.mjs` as the
entry, and name the product; `product-service.json` must pin exactly the origin
that was passed in; and no update feed may remain. It prints a JSON receipt
with the origin, output directory, and verified apps.

## 3. What this does not do

- No payment, subscription, or purchase page. Balance is a service quota an
  operator funds through the CLI; it is not automatic billing.
- No signature or notarization claim. Signing needs the operator's own
  certificate; an unsigned build is for verification only.
- No cross-platform claim from one host. The macOS arm64 directory build and
  DMG are the deliverable here; Windows and Linux paths are implemented but
  must be built and smoked on their own systems.
- No loopback service is shipped by default: a product build pins the operator's
  public origin unless `--local-origin` was passed deliberately.
- Native macOS helpers require an initialized, matching Xcode toolchain.
  Select it with `xcode-select` and finish `xcodebuild -runFirstLaunch` before
  packaging; do not bypass failed native builds or omit required resources.
- No out-of-box loopback trust unless the build bundles one: a product build
  shipped with `--gateway-ca` verifies that gateway's own certificate and needs
  no OS trust-store import; without it, a generated gateway certificate must be
  installed in each client's OS trust store, or replaced with a CA-issued one.
- No migration of existing local profiles. The product app has its own
  application id and account data directory; a previous `~/.openmausbot` is
  left untouched for the user to import through the in-app flow.
