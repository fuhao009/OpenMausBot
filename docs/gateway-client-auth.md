# Gateway client authentication API

This is the client contract for the control-plane Worker, not the local desktop server's owner-session API. All example identities, passwords, codes and credentials below are placeholders. Replace `https://gateway.example.com` with the configured control-plane **origin**; do not append another `/api` prefix.

Authoritative implementation and related documentation:

- [Desktop HTTP client](../desktop/electron/control-plane-client.mjs), [product authentication flows](../desktop/electron/product-account-authentication.mjs) and [account lifecycle](../desktop/electron/product-account.mjs).
- Worker [auth configuration](../gateway/control-plane/src/auth.ts), [route dispatch and error mapping](../gateway/control-plane/src/index.ts), [CORS/security headers](../gateway/control-plane/src/http.ts), [environment policy](../gateway/control-plane/src/config.ts), and [recipient throttling](../gateway/control-plane/src/otp-rate-limit.ts).
- [Control-plane deployment and API guide](../gateway/control-plane/README.md), [client API overview](gateway-client-api.md), and [HighLevel integration guide](highlevel.md).

## Transport and credential rules

Send `Accept: application/json`, and `Content-Type: application/json` when sending a JSON body. These auth/relay requests have a 16 KiB body limit. HTTPS is required for deployed origins. The Electron client refuses redirects, uses a 15-second default request deadline, and can use the deployment's pinned CA without disabling hostname or certificate verification.

**An account bearer is the signed value in the successful response's `set-auth-token` header. Never use the JSON `token` field as an account credential.** Better Auth's JSON token is the raw database token, and the Worker enables `bearer({requireSignature:true})`. Native clients read the header directly, keep it secret, and subsequently send:

```http
Authorization: Bearer <signed-set-auth-token-value>
```

Do not decode, re-sign or substitute a cookie, installation credential (`omb_install_…`), or model credential (`omb_product_ai_…`). `/v1/me` and the other account routes explicitly require an account bearer; cookie-only requests do not authenticate these routes.

### Native versus browser requests

- The native Electron client sets `Origin` to the validated control-plane origin **only on `/api/auth/*` requests**. Node fetch sends `Sec-Fetch-Mode: cors`; the explicit trusted origin lets Better Auth retain its CSRF checks. Use the same pattern for native clients with that fetch behavior. Native fetch can read `set-auth-token` without browser CORS exposure and does not maintain a browser cookie session for these calls.
- Better Auth also emits secure session cookies (default `HttpOnly`, `SameSite=Lax`, path `/`). These are not a replacement for the signed bearer on `/v1/*` account APIs.
- The Worker accepts only configured `ALLOWED_ORIGINS`, plus `BETTER_AUTH_URL` itself. An unapproved supplied `Origin` returns `403 {"error":"origin_not_allowed"}`. Omitting Origin does not bypass Better Auth's own browser/CSRF checks.
- Allowed browser preflight: `OPTIONS`, requested method `GET`, `POST` or `DELETE`, and requested headers `authorization` and/or `content-type`; success is `204`. Other preflights return `403 origin_not_allowed`.
- Responses echo an allowed origin and use `Vary: Origin`, but the Worker does **not** advertise `Access-Control-Allow-Credentials` or expose `set-auth-token` with `Access-Control-Expose-Headers`. Therefore a cross-origin browser SPA must not assume it can read that header or use credentialed cookie fetch. The native contract below is not a promise of cross-origin browser login support. Same-origin browser requests remain subject to Better Auth's cookie/CSRF behavior.
- HighLevel's top-level callback GET is the deliberate Origin-check exception: it may arrive with a foreign or `null` Origin.

All responses are `Cache-Control: no-store` and carry `x-request-id`; retain the request ID for troubleshooting, not passwords, OTPs or tokens.

## Discover available methods

```sh
curl -sS 'https://gateway.example.com/v1/auth/methods'
```

`200` example:

```json
{
  "password": { "enabled": true, "minLength": 10, "maxLength": 128 },
  "emailCode": { "enabled": false },
  "emailVerification": "off"
}
```

This endpoint is public and contains no account information. Password signup/signin is always enabled. Use the returned password bounds (currently **10–128 characters**); the low-level desktop client's broader local input guard is not the server password policy.

Email codes are enabled only when both a valid `EMAIL_FROM` sender and an `EMAIL.send` transport binding exist. Verification defaults to `required` with mail and `off` without mail; `AUTH_EMAIL_VERIFICATION` may explicitly select either mode. Explicit `required` without mail is a misconfiguration, not a working sign-up flow.

**Without mail, every `/api/auth/email-otp/*` route, `/api/auth/sign-in/email-otp`, and the legacy `/api/auth/forget-password/email-otp` return `503 {"error":"email_unavailable"}`.** This includes confirmation and reset submission, not just requesting a code. No email is silently sent and no undeliverable OTP is stored. Password login still works with verification off, but email OTP login, emailed confirmation and forgotten-password recovery are unavailable. Discovery reports capability/configuration, not delivery success; deployed mail onboarding and actual delivery remain operator prerequisites.

## Password account flows

All requests in this section are unauthenticated JSON POSTs with `Origin: https://gateway.example.com` for the native fetch pattern above. Normalize email by trimming and lowercasing it. The desktop client uses the email local part as the signup display name; passwords must not be trimmed, logged or saved.

### Sign up

```sh
curl -i 'https://gateway.example.com/api/auth/sign-up/email' \
  -H 'Origin: https://gateway.example.com' -H 'Content-Type: application/json' \
  --data '{"email":"person@example.com","password":"<new-password-10-to-128-characters>","name":"person"}'
```

- Verification `off`: `200`, user JSON and a session; capture **`set-auth-token`**, not JSON `token`. The desktop wrapper returns `{accountToken, user}`.
- Verification `required`: `200`, `{ "token": null, "user": {…} }`, **no `set-auth-token`**. Signup sends an `email-verification` code. The wrapper returns `{accountToken:null,user}`; this is not a signed-in state. Confirm the email, then sign in with the password.
- With verification off an existing email returns `422 email_taken`. With required verification Better Auth can return an enumeration-safe `200` with `token:null` for an existing address; do not treat this as proof that a new account was created.
- Password outside the configured range: `400 password_too_short` or `400 password_too_long`.

Account creation alone does not grant AI access or balance. Retrieve the account's separate AI state after login; see the [client API overview](gateway-client-api.md).

### Sign in

```sh
curl -i 'https://gateway.example.com/api/auth/sign-in/email' \
  -H 'Origin: https://gateway.example.com' -H 'Content-Type: application/json' \
  --data '{"email":"person@example.com","password":"<existing-password>"}'
```

Success is `200` with user JSON and signed `set-auth-token`. Unknown address and wrong password both return `401 {"error":"invalid_credentials"}`. If verification is required and the address has not been confirmed, the response is `403 {"error":"email_not_verified"}`; no session is admitted.

## Email OTP flows (mail-enabled deployments only)

Codes are **eight decimal digits**, expire after **10 minutes**, are stored hashed, and are consumed on successful verification. Each purpose has its own code: `sign-in`, `email-verification`, or `forget-password`. Never submit a sign-in code as an email-confirmation code. Resending rotates the code; only the latest delivered code should be used. Desktop input normalization removes whitespace/hyphens before requiring eight digits.

| Action / desktop method | Exact JSON POST URL | Body | Successful HTTP answer |
|---|---|---|---|
| Request sign-in code / `requestOTP` | `/api/auth/email-otp/send-verification-otp` | `{"email":"person@example.com","type":"sign-in"}` | `200 {"success":true}`; no session |
| Sign in or create account with code / `verifyOTP` | `/api/auth/sign-in/email-otp` | `{"email":"person@example.com","otp":"<8-digit-code>","name":"person"}` | `200`, user plus signed `set-auth-token`; JSON token must be ignored |
| Resend email-confirmation code | `/api/auth/email-otp/send-verification-otp` | `{"email":"person@example.com","type":"email-verification"}` | `200 {"success":true}`; no session |
| Confirm email / `verifyEmailOTP` | `/api/auth/email-otp/verify-email` | `{"email":"person@example.com","otp":"<8-digit-confirmation-code>"}` | `200 {"status":true,"token":null,"user":{…}}`; then password signin |
| Request password-reset code / `requestPasswordResetOTP` | `/api/auth/email-otp/request-password-reset` | `{"email":"person@example.com"}` | `200 {"success":true}`; no session |
| Set new password / `resetPasswordWithOTP` | `/api/auth/email-otp/reset-password` | `{"email":"person@example.com","otp":"<8-digit-reset-code>","password":"<new-password-10-to-128-characters>"}` | `200 {"success":true}`; then explicit password signin |

For example, request a sign-in code, then submit the value the person actually received:

```sh
curl -i 'https://gateway.example.com/api/auth/email-otp/send-verification-otp' \
  -H 'Origin: https://gateway.example.com' -H 'Content-Type: application/json' \
  --data '{"email":"person@example.com","type":"sign-in"}'

curl -i 'https://gateway.example.com/api/auth/sign-in/email-otp' \
  -H 'Origin: https://gateway.example.com' -H 'Content-Type: application/json' \
  --data '{"email":"person@example.com","otp":"<received-8-digit-code>","name":"person"}'
```

OTP signin allows account creation for a new email and marks the email verified. It is distinct from password-signup confirmation: confirmation creates no session, and the product flow follows it with password signin. Password reset likewise never silently signs in on a shared computer. Reset updates/creates the password credential and marks the address verified; this deployment does **not** enable `revokeSessionsOnPasswordReset`, so do not promise that reset logs out existing sessions.

Unknown/known email requests use generic success responses; `200 success` does not prove an address exists or a message was delivered. Email sends run through Better Auth's background task handling, so transport failures are not a reliable synchronous delivery receipt.

### OTP and password errors / throttling

Worker auth errors have the stable shape `{"error":"lowercase_code"}`, not Better Auth's upstream `{code,message}` shape:

| Status | Common code and meaning |
|---|---|
| `400` | `invalid_email`, `invalid_request`, `invalid_otp` (wrong, absent, or already consumed code), `otp_expired`, `password_too_short`, `password_too_long` |
| `401` | `invalid_credentials` for password signin; `unauthorized` for invalid account authentication |
| `403` | `email_not_verified`; `rate_limited` after the code's five allowed failed attempts are exhausted; `origin_not_allowed` for a rejected Origin |
| `422` | `email_taken` for duplicate password signup with verification off |
| `429` | `rate_limited` for request-rate limits |
| `503` | `email_unavailable` for disabled emailed flows |
| `500` | `internal_error`; dependency 5xx responses are sanitized to this status/code |

Better Auth's D1-backed per-IP limits are 5/minute for signup, OTP sends and each reset route, 10/minute for password/OTP signin, and a default 60/minute for other auth requests. The OTP plugin also has its own 5/minute rate limit. Separately, `send-verification-otp` is limited to **3 sends per recipient per 15 minutes**, even across IPs. Exhausting that recipient budget intentionally returns `200 {"success":true}` without rotating/sending another code. Do not turn that into a delivery guarantee or repeatedly resend automatically. Inspect HTTP status as well as code: `rate_limited` is not exclusively a 429. Honor a numeric `Retry-After` when supplied; the desktop transport only accepts delay-seconds, not an HTTP date.

## Current account and session lifecycle

```sh
curl -i 'https://gateway.example.com/v1/me' \
  -H 'Authorization: Bearer <signed-set-auth-token-value>'
```

`200`:

```json
{"user":{"id":"<user-id>","email":"person@example.com","name":"person","emailVerified":true}}
```

Missing, expired, invalid, raw or wrong-kind bearer returns `401 {"error":"unauthorized"}`. A password account with verification off can legitimately have `emailVerified:false`. The desktop low-level wrapper returns only `{id,email}` from this response, not the entire auth user object.

The Worker stores Better Auth sessions in D1 and does not override the pinned dependency's session defaults: seven-day expiry, eligible rolling renewal after one day on session lookup. The bearer is a signed opaque session token, not a JWT with a client-readable expiry. There is no custom account refresh-token endpoint: validate a saved account bearer through `/v1/me`; if it is unauthorized, clear the saved session and ask the person to authenticate again. The desktop validates `/v1/me` before restoring a saved login and before accepting a new authenticated result. Network failure is not evidence of logout.

```sh
curl -i -X POST 'https://gateway.example.com/api/auth/sign-out' \
  -H 'Origin: https://gateway.example.com' \
  -H 'Authorization: Bearer <signed-set-auth-token-value>'
```

No request body is required. Success is `200 {"success":true}`. Signout deletes the current session; subsequent account requests with that signed bearer fail authentication. It is not an all-devices logout and does not revoke separate installation credentials or delete their endpoints. Model credentials are session-bound and stop authorizing model work when their parent session is gone. The product's local logout also stops the account workspace, clears its local capability/session state and removes its saved login; installation/endpoint cleanup belongs to the companion lifecycle, not to this HTTP signout route.

Keep account tokens in native credential storage, not renderer state, URLs, logs or source files. The desktop sends passwords only for the auth operation and does not persist them. Account login, installation authentication and short-lived model authorization have separate lifecycles; follow the [client API overview](gateway-client-api.md) for their use.

## HighLevel OAuth relay (separate from account login)

The relay is used by the desktop/Cloud home's HighLevel connector, not by password signin. It requires **no Hezuo account bearer**. The unguessable returned `state` authorizes a one-time claim; protect it like a credential. `refreshToken` is likewise a credential. HighLevel's client secret remains on the Worker and must never be supplied by a client. These are location-level flows only, not company/agency flows.

For application UI integration, prefer the local owner-session routes documented in [HighLevel: owner routes](highlevel.md#owner-routes-desktopserverrouteshighlevelts-admin-or-owner-session-only). Those `/api/highlevel/*` routes are on the OMB server, **not** the relay Worker; they manage polling, encrypted token storage and connector state without returning tokens to the UI. The relay defaults to `https://accounts.openmausbot.com`; use the configured `OMB_HIGHLEVEL_RELAY_URL` when overridden.

### 1. Start

```sh
curl -i 'https://accounts.openmausbot.com/v1/highlevel/start' \
  -H 'Content-Type: application/json' --data '{"kind":"location"}'
```

`200` returns `{"state":"<43-character-base64url-state>","authorizationUrl":"<HighLevel-authorization-URL>","expiresAt":<unix-milliseconds>}`. The strict body accepts only `kind:"location"`. Open the returned URL in the person's browser, retain the exact canonical state, and poll claim every two seconds for no more than ten minutes. The authorization URL is built for `https://marketplace.leadconnectorhq.com/v2/oauth/chooselocation` with `response_type=code`, configured redirect URI, client ID, scopes and state. Do not manufacture or replace the state.

### 2. Provider callback

HighLevel navigates the browser to the configured redirect, normally:

```http
GET /v1/highlevel/callback?code=<URL-encoded-provider-code>&state=<state-from-start>
```

Cancellation example:

```http
GET /v1/highlevel/callback?error=access_denied&state=<state-from-start>
```

This is a **browser navigation**, not a client token-exchange request. The Worker exchanges the single-use code server-side and returns fixed HTML, never tokens: `200` Connected on success, `200` Connection cancelled on provider cancellation, `400` Connection expired for an invalid/unknown/expired/reused state, `502` Connection failed for an invalid code or failed exchange, and `503` when relay configuration is unavailable. Cancellation/failed exchange ends the flow; claims then see 404. Callback may also return JSON `429 rate_limited`.

### 3. Claim once

```sh
curl -i 'https://accounts.openmausbot.com/v1/highlevel/claim' \
  -H 'Content-Type: application/json' --data '{"state":"<exact-state-from-start>"}'
```

- `200` returns the token payload below exactly once.
- `404 {"error":"highlevel_unknown_state"}` means waiting, unknown, cancelled, or expired. Continue polling only within the original flow deadline, not indefinitely.
- `410 {"error":"highlevel_claimed"}` means already consumed (including a racing claim); never treat it as a pending flow. After TTL/sweep, a formerly claimed state may instead be 404.

### 4. Refresh and persist the rotated pair

```sh
curl -i 'https://accounts.openmausbot.com/v1/highlevel/refresh' \
  -H 'Content-Type: application/json' \
  --data '{"refreshToken":"<current-HighLevel-refresh-token>"}'
```

Claim and refresh `200` payload:

```json
{
  "accessToken": "<HighLevel-access-token>",
  "refreshToken": "<rotated-HighLevel-refresh-token>",
  "expiresIn": 86400,
  "scope": "<space-separated-granted-scopes>",
  "locationId": "<location-id>",
  "companyId": "<company-id>",
  "userId": "<provider-user-id>"
}
```

`expiresIn` is seconds, unlike the start response's millisecond `expiresAt`; use the actual returned lifetime. Optional upstream scope/identifier fields are normalized to empty strings when absent. Persist the entire rotated pair before using it for a retry; do not keep using the old refresh token. `401 highlevel_refresh_rejected` means reconnect is needed (for example revoked/uninstalled app); `502 highlevel_refresh_failed` means the exchange failed. Neither is an account-password error. Refresh does not extend a relay claim flow; it directly exchanges the supplied provider credential.

All three JSON POST schemas are strict: extra/malformed fields return `400 invalid_request`; non-JSON bodies return `415 unsupported_media_type`, oversized bodies `413 request_too_large`. Start/claim/refresh return `503 highlevel_unavailable` when the relay lacks valid configuration. Per-IP hourly budgets are start 60, callback 60, claim 3,000, refresh 600; exceeding them returns `429 rate_limited` with `Retry-After: 60`.

The relay flow lasts ten minutes. D1 stores a state-derived lookup key and encrypted token payload, never the plaintext state or tokens. Claim clears the ciphertext and records consumption; cron removes expired flow rows. The connector stores claimed tokens encrypted in its own DATA_DIR and handles refresh/reconnect/disconnect as described in the [HighLevel integration guide](highlevel.md), including the Private Integration token alternative, permissions and provider limits. Disconnecting the connector is not Hezuo account signout.
