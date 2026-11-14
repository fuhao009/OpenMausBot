# Desktop Bot test HTTP API

This opt-in, local automation interface sends natural-language requests to a dedicated project Bot. It is not a browser UI, a generic server proxy, or a replacement model/tool implementation. The desktop UI remains inaccessible from browsers.

## Enable and locate

Start the desktop explicitly with `--bot-test-api`. Without that command-line flag the interface is disabled. For a development Electron launch, pass the flag to the Electron application (not merely to the package manager).

The active account's data root contains `bot-test-api.json` while its interface is available:

```json
{"url":"http://127.0.0.1:<random-port>","token":"<private-per-session-token>"}
```

The listener binds only to `127.0.0.1`, chooses a random port, and uses an independent random bearer token. The descriptor is private (`0600` on POSIX); its token is not the desktop's internal owner credential. Never commit, print, screenshot, upload, or paste this file or token into chat. Do not place it in a URL. Restrict access to the account data root as well.

Account shutdown/switch and application exit close the listener, revoke the token, cancel its pending owned task, and remove the descriptor. A later account runtime gets a fresh token and no previous runtime's in-memory runs. Do not treat a descriptor left after a crash as a live service; relaunch the desktop normally.

## Authentication and request restrictions

Every endpoint requires `Authorization: Bearer <token>`. Requests bearing `Origin` or browser fetch metadata are rejected, even with the right token. No CORS access is granted. Use a local non-browser HTTP client; browser JavaScript, a browser extension, and opening the URL in a browser are not supported clients.

Only the endpoints below exist. Callers cannot select a Bot, thread, upstream URL, model, arbitrary API path, or tool. JSON submissions are limited to 64 KiB, including encoding overhead, and accept exactly one nonempty string field, `text`. There is one active run per account runtime. A concurrent submission returns `409`; missing or incorrect authentication returns `401`, browser requests return `403`, malformed payloads return `400`, oversized bodies return `413`, and non-JSON submissions return `415`. Unknown paths/run IDs return `404`.

## Endpoints

| Method and path | Request | Response |
| --- | --- | --- |
| `GET /v1/status` | No body | `{status:"ready", bot, activeRunId, runs}` |
| `POST /v1/runs` | `{"text":"natural-language task"}` | `202`, `{run}` |
| `GET /v1/runs/:id` | No body | `{run}` |
| `POST /v1/runs/:id/stop` | No body | `{run}` after the scoped stop request |

The first accepted submission creates **Desktop API Test Bot**, using the account's normal default model selection. It enables the Bot's browser capability, but retains normal approval behavior; it does not grant blanket permission or automatically approve tools. Every submission creates a fresh task on that dedicated Bot. Existing Bots and conversations are not targets. The Bot uses the normal server model/gateway dispatch; the interface never substitutes scripted tool execution or a fallback model.

`bot` is initially `null`, then `{id,name}`. `activeRunId` is `null` when no run is active. `runs` holds up to the latest 50 in-memory runs for this runtime, not a persistent account history. A completed run's Bot/task conversation remains available through the normal desktop.

### Run status and evidence

A run contains:

- `id`, original `prompt`, `bot`, `threadId`, and `requestMessageId`.
- `status`: `starting` (creating/submitting), `running`, `needs-user` (an observed unresolved approval/input request), `stopping`, or a terminal `completed`, `failed`, `stopped`.
- `configuredModel`: the Bot/task selection; `actualModel`: the model identity observed from a runtime session event, otherwise `null`. Configured identity alone does not prove a provider was called.
- `finalText`: the completed Bot reply, otherwise `null`; `error`: a failure description or `null`.
- `startedAt` and `completedAt`: epoch-millisecond timestamps (`completedAt` is `null` while active). `elapsedMs` uses a monotonic clock to measure elapsed time since submission, updated while active and fixed on completion; it is not computed by subtracting the wall-clock timestamps.
- `timings.dispatchMs`: monotonic elapsed time from submission through normal server send acknowledgement; `firstModelEventMs` and `firstTextMs`: offsets from submission to the timestamps of the first observed nonsynthetic runtime event and assistant text event respectively. These are observed milestones, **not provider inference durations**, and event timestamp offsets are not guaranteed to share the monotonic elapsed clock.
- `tools`: observed tool names, inputs, outputs/results, completion state, start/end timestamps and `elapsedMs` when known.
- `requests`: observed approval/input request identities, types, summaries, open/resolved timestamps and resolution behavior.

Unknown event timings remain `null`; absent events are not measured as zero or invented from the whole-turn duration. Milestones and tool intervals can overlap and must not be added together. A completed Bot reply proves the turn completed, not that a browser page independently passed acceptance. `needs-user` requires using the normal desktop approval/input UI; this API intentionally has no approval bypass endpoint. Stop is scoped to this interface's task and is safe to repeat after a terminal result.

Prompts, tool arguments, results, and Bot output may themselves contain sensitive data. Protect any captured status/report files just like the underlying conversation; the bearer token must never appear in them.

## Local curl example

Set the descriptor path to the active account's actual data root. This example keeps the token out of command arguments, terminal output, and shell tracing by piping a generated curl configuration through standard input. It requires Node and curl. Do not enable `set -x`, curl verbose/trace output, or log standard input.

```sh
export BOT_TEST_DESCRIPTOR='/absolute/path/to/account-root/bot-test-api.json'

bot_test_request() {
  BOT_TEST_METHOD="$1" BOT_TEST_PATH="$2" node --input-type=module <<'NODE' | curl --silent --show-error --fail-with-body --config -
import { readFileSync } from 'node:fs';
const { url, token } = JSON.parse(readFileSync(process.env.BOT_TEST_DESCRIPTOR, 'utf8'));
console.log(`url = ${JSON.stringify(url + process.env.BOT_TEST_PATH)}`);
console.log(`request = ${JSON.stringify(process.env.BOT_TEST_METHOD)}`);
console.log(`header = ${JSON.stringify('Authorization: Bearer ' + token)}`);
if (process.env.BOT_TEST_METHOD === 'POST' && process.env.BOT_TEST_PATH === '/v1/runs') {
  console.log('header = "Content-Type: application/json"');
  console.log(`data = ${JSON.stringify(JSON.stringify({ text: 'Please describe what you can help me test.' }))}`);
}
NODE
}

bot_test_request GET /v1/status
bot_test_request POST /v1/runs
# Replace RUN_ID with the returned run.id, not a Bot or thread ID.
bot_test_request GET /v1/runs/RUN_ID
bot_test_request POST /v1/runs/RUN_ID/stop
```

## Isolated wiring verification

From the repository root, run:

```sh
node --experimental-strip-types scripts/verify-bot-test-api.mjs
```

The script uses `launchVerificationServer` and the shared control tool against a disposable fake-engine account. It instantiates the actual `createBotTestApi` module with an owner-authenticated fixture request adapter. It checks authentication and browser denial, private descriptor lifecycle, dedicated Bot/conversation isolation, normal fixture engine completion, observed timing fields, fresh tasks, scoped stop, account-close cancellation, and old-token rejection on a new runtime. It cleans up only its own fixture data/processes and never connects to the user's running desktop or production model account.

**A passing fake-engine fixture proves wiring only. It is not a real AI result or browser acceptance.** For real model/browser acceptance, follow [the Bot model/browser acceptance procedure](bot-model-browser-acceptance.md): record actual model identity and runtime/tool events, preserve normal approvals, and independently inspect the actual embedded page. This HTTP interface does not make a direct scripted browser operation count as a model-driven result.

## Verification record — 2026-11-14

- `node --test desktop/electron/bot-test-api.test.mjs`: 5 tests passed.
- `node --experimental-strip-types scripts/verify-bot-test-api.mjs`: passed; measured command wall time 1.93 seconds after correcting the fixture owner-token encoding to the production base64url format.
- Verified normal Bot dispatch/completion, dedicated Bot isolation, fresh tasks, stop, close cancellation, token rotation, descriptor removal/permissions, and authorization/browser rejection.
- This is fake-engine integration proof, not real-model/browser acceptance. No installed application was updated, and no persistent test listener was left running.
