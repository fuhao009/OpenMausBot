# Verifying the product account end to end

`node scripts/verify-product-account.mjs` runs the real app against the real
account Worker in one disposable place. It needs no operator domain, Cloudflare
account, model key or Cloud account.

```sh
node scripts/verify-product-account.mjs                      # this checkout's Electron, emailed codes
node scripts/verify-product-account.mjs --app "/Applications/OpenMausBot Product.app"
node scripts/verify-product-account.mjs --app "…/OpenMausBot Product.app" --bundled-trust
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

The first form builds `cloudflare/control-plane/src/index.ts` with esbuild and
runs it under the Miniflare that the control-plane's pinned Wrangler ships, over
TLS on `127.0.0.1` with a self-signed certificate. It applies this checkout's
migrations to a fresh D1 database, sends its one-time codes through the Worker's
real `EMAIL` binding (a disposable mailbox), and reaches a loopback upstream
through the Worker's own egress. The desktop app is the real
`electron/main.mjs`, started with its explicit fixture entry
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
