# @seolyticize/mock

A stand-in for the Seolyticize API, for tests and local development. It reads
the real OpenAPI document, so when the API changes, the mock changes with it.

- An unknown tool returns `404 unknown_tool`.
- A missing required field returns `400 invalid_input`.
- A missing or wrong key returns `401 unauthorized`.

Every refusal has the API's own shape (`{ error, code, requestId }`). A call that
passes returns your fixture as the API does: `{ ok, outcome, data, meta }`, with
`outcome` (and `meta.outcome`) on every tool that is not read-only. `POST
/api/collect` returns `202 { visit }` and keeps each event it receives.

```sh
npx @seolyticize/mock --port 4600 --fixtures test/fixtures   # test/fixtures/list_clients.json …
SEOLYTICIZE_BASE_URL=http://127.0.0.1:4600 seolyticize clients
```

`--spec` takes a saved `openapi.json` and `--errors` a saved `GET /api/v1/errors`,
which lets CI run offline. By default both are read from https://seolyticize.com.
`--key` accepts only that key. `--scenario create_client=noop` (repeatable) sets
how a tool answers; see Scenarios.

## Install

```sh
npm install --save-dev @seolyticize/mock
```

## In unit tests, with no server

```ts
import { createMock } from "@seolyticize/mock";
import { createClient } from "@seolyticize/sdk";

const mock = createMock({
  spec, // the saved openapi.json
  errors, // optional: the saved /api/v1/errors, for real refusal sentences
  fixtures: {
    list_clients: { clients: [{ id: "client_1" }] },
    get_indexnow_key: (input) => ({ key: `key-${input.clientId}` }),
  },
});
const sdk = createClient({
  apiKey: "sk_seo_test",
  baseUrl: "http://mock.local",
  fetch: mock.fetch,
});
await sdk.call("list_clients", {});
expect(mock.calls).toEqual([{ tool: "list_clients", input: {} }]);
```

`mock.fetch` also works as `@seolyticize/node`'s `transport`. The events it
receives land in `mock.events`.

## Scenarios: noop, 202 jobs, refusals

`scenarios: { tool: … }` in `createMock`, `--scenario tool=…` on the command
line, or the `X-Mock-Scenario: …` header on one call:

| Scenario             | Answer                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applied` (default)  | `200`, your fixture; `outcome: "applied"` on a write                                                                                                                              |
| `noop`               | `200`, `outcome: "noop"`, `reason: "already_exists"`                                                                                                                              |
| `partial`, `skipped` | `200`, that outcome, with `some_failed` or `dry_run`                                                                                                                              |
| `queued`             | `202 { ok, outcome: "queued", jobId, idempotencyKey, pollAfterSeconds }`; the same body sent again with that `Idempotency-Key` answers the fixture. The SDK does this on its own. |
| `declined`           | `409 { ok: false, refused, reason }`, a tool declining as data                                                                                                                    |
| any other string     | `402`, `409` or `422` (as the API answers that code) with it, and the catalogue's sentence and fix when `errors` is given (`unknown_client`, `plan_limit`, …)                     |

`X-Mock-Refuse: <code>` still works as a shortcut for a refusal with that code.

## Recorded answers and fixtures

`@seolyticize/mock/fixtures` builds the API's answers without the mock, for a
test that stubs `fetch` itself:

```ts
import {
  accepted,
  declined,
  recordedAnswers,
  refusal,
  success,
} from "@seolyticize/mock/fixtures";

success({ clients: [] }); // a read
success({ id: "c1" }, "noop"); // a write that was already so
accepted("call_1"); // the 202 of a slow call
refusal("plan_limit", "Over the plan."); // a refusal body (402 for plan_limit)

// Every tool's answers, derived from the OpenAPI document and the error catalogue:
const recorded = recordedAnswers(spec, { errors, refusals: ["unknown_client"] });
recorded.create_client; // [{ scenario: "applied", status: 200, request, body }, noop, queued, invalid_input, unauthorized, unknown_client]
```

`npx @seolyticize/mock --record > recorded.json` writes the same for every tool.
Each request is the document's own example input, generated from the tool's
schema, and the mock answers it exactly as recorded.

**What it cannot record:** the API publishes no output schemas (the tools'
answers have no runtime schema to publish), so `data` is your fixture, or `{}`
for a tool without one.
