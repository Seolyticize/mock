/**
 * The API's answers, built exactly as it builds them (apps/web's apiHandler):
 * the success envelope with its outcome, a decline as data, a refusal, and the
 * 202 a slow call answers. createMock answers with these, and they are
 * exported as @seolyticize/mock/fixtures for a test that stubs fetch itself.
 *
 * recordedAnswers(spec) derives, for every tool in the OpenAPI document, an
 * example request (the document's own example, generated from the tool's
 * input schema) and each answer it can get. Nothing here is hand-written per
 * tool: the API publishes no output schemas, so `data` is your fixture, or {}.
 */

export type OpenApiOperation = {
  operationId?: string;
  summary?: string;
  requestBody?: { content?: Record<string, { example?: unknown }> } | unknown;
  "x-seolyticize-read-only"?: boolean;
};

export type OpenApiDocument = {
  paths: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, { required?: string[] }> };
};

/** GET /api/v1/errors: every refusal code with what it means and what fixes it. */
export type ErrorCatalogue = {
  errors: Array<{ code: string; meaning: string; fix: string; next: string | null }>;
};

/** What a write did: applied, noop (already so), partial, skipped, or queued. */
export type Outcome = "applied" | "noop" | "partial" | "skipped" | "queued";

/** The reason the API gives beside each outcome that is not applied. */
export const OUTCOME_REASONS: Record<Outcome, string | undefined> = {
  applied: undefined,
  noop: "already_exists",
  partial: "some_failed",
  skipped: "dry_run",
  queued: undefined,
};

export const REQUEST_ID = "req_mock";
/** Seconds a 202 asks the caller to wait before collecting; the API's own. */
export const POLL_AFTER_SECONDS = 5;

export function meta(outcome?: Outcome, reason?: string) {
  return {
    requestId: REQUEST_ID,
    costMicros: 0,
    cached: false,
    cachedFrom: null,
    dataAsOf: null,
    sources: [],
    partial: outcome === "partial",
    next: [],
    nextCursor: null,
    ...(outcome ? { outcome } : {}),
    ...(reason ? { reason } : {}),
  };
}

/** 200: the tool's result. A write (not read-only) carries its outcome beside ok and in meta. */
export function success(
  data: unknown,
  outcome?: Outcome,
  reason = outcome && OUTCOME_REASONS[outcome],
) {
  return {
    ok: true,
    ...(outcome ? { outcome } : {}),
    ...(reason ? { reason } : {}),
    data,
    meta: meta(outcome, reason),
  };
}

/**
 * The status a refusal answers with: 402 money, 422 input to change, 409 the
 * rest. A copy of @seolyticize/mcp's refusalStatus (this package ships with no
 * dependencies); answers.test.ts holds the two to the same answers.
 */
export function refusalStatus(code: string): 402 | 409 | 422 {
  const normal = code.replaceAll("-", "_");
  if (
    [
      "budget_exceeded",
      "over_spend_limit",
      "spend_cap_exceeded",
      "plan_limit",
      "vendor_balance_empty",
    ].includes(normal)
  )
    return 402;
  return /^(?:(?:invalid|malformed|missing|bad|unsupported|mistyped|too_many)_.+|too_many|.+_(?:required|too_long|too_large)|empty_list_name|unrecognised_csv|incomplete_credential|unsafe_target|idempotency_key_reused)$/.test(
    normal,
  )
    ? 422
    : 409;
}

/** 409 (by its code) with ok:false: a tool that declined as data (not connected, nothing to do). */
export function declined(refused: string, reason: string, next?: unknown) {
  const data = { refused, reason, ...(next === undefined ? {} : { next }) };
  return {
    ok: false,
    outcome: "skipped" as const,
    refused,
    reason,
    next,
    data,
    meta: meta("skipped", refused),
  };
}

/** A refusal: { error, code, next?, requestId }, the shape of every 4xx and 5xx. */
export function refusal(code: string, error: string, next?: string | null) {
  return { error, code, ...(next ? { next } : {}), requestId: REQUEST_ID };
}

/** 202: still running after 25 s. POST the same body under idempotencyKey to collect it. */
export function accepted(idempotencyKey: string) {
  return {
    ok: true,
    outcome: "queued" as const,
    jobId: `call:${idempotencyKey}`,
    idempotencyKey,
    pollAfterSeconds: POLL_AFTER_SECONDS,
    next: `Still running. POST the same body again with Idempotency-Key: ${idempotencyKey} for the answer; until it is ready that answers 202 again.`,
    requestId: REQUEST_ID,
  };
}

export type ToolShape = {
  title: string;
  required: string[];
  readOnly: boolean;
  example: Record<string, unknown>;
};

/** Every tool in the document, with what the mock and the recordings need of it. */
export function toolsOf(spec: OpenApiDocument): Map<string, ToolShape> {
  const tools = new Map<string, ToolShape>();
  for (const [path, item] of Object.entries(spec.paths)) {
    const match = /^\/api\/v1\/tools\/([a-z0-9_]+)$/.exec(path);
    const post = item["post"];
    if (!match || !post) continue;
    const body = post.requestBody as
      { content?: Record<string, { example?: unknown; schema?: unknown }> } | undefined;
    const content = body?.content?.["application/json"];
    const ref = JSON.stringify(content?.schema ?? "").match(
      /#\/components\/schemas\/([^"]+)/,
    );
    const schema = ref ? spec.components?.schemas?.[ref[1]!] : undefined;
    const example = content?.example;
    tools.set(match[1]!, {
      title: post.summary ?? match[1]!,
      required: schema?.required ?? [],
      // A document without the flag: treat the tool as a write, as the SDK does.
      readOnly: post["x-seolyticize-read-only"] === true,
      example:
        example && typeof example === "object" && !Array.isArray(example)
          ? (example as Record<string, unknown>)
          : {},
    });
  }
  return tools;
}

export type RecordedAnswer = {
  /** applied, noop, queued, declined, invalid_input, unauthorized, or a refusal code. */
  scenario: string;
  status: number;
  request: {
    tool: string;
    input: Record<string, unknown>;
    headers?: Record<string, string>;
  };
  body: unknown;
};

/**
 * Every answer each tool can give, derived from the OpenAPI document and, when
 * given, the error catalogue (GET /api/v1/errors): the success (with outcome
 * applied for a write), noop for a write, the 202 any slow call answers, the
 * 400 its required fields cause, 401, and a refusal for each catalogued code
 * named in `refusals` (default: refused), at its status (402, 409 or 422).
 */
export function recordedAnswers(
  spec: OpenApiDocument,
  options: { errors?: ErrorCatalogue; refusals?: string[] } = {},
): Record<string, RecordedAnswer[]> {
  const catalogue = new Map(
    (options.errors?.errors ?? []).map((e) => [e.code, e] as const),
  );
  const out: Record<string, RecordedAnswer[]> = {};
  for (const [tool, shape] of toolsOf(spec)) {
    const input = shape.example;
    const answers: RecordedAnswer[] = [
      {
        scenario: "applied",
        status: 200,
        request: { tool, input },
        body: success({}, shape.readOnly ? undefined : "applied"),
      },
    ];
    if (!shape.readOnly)
      answers.push({
        scenario: "noop",
        status: 200,
        request: { tool, input },
        body: success({}, "noop"),
      });
    answers.push({
      scenario: "queued",
      status: 202,
      request: { tool, input },
      body: accepted(`call_${tool}`),
    });
    if (shape.required.length > 0)
      answers.push({
        scenario: "invalid_input",
        status: 400,
        request: { tool, input: {} },
        body: refusal(
          "invalid_input",
          `Invalid input for ${tool} — ${shape.required.map((f) => `${f}: Required`).join("; ")}`,
        ),
      });
    answers.push({
      scenario: "unauthorized",
      status: 401,
      request: { tool, input, headers: { authorization: "" } },
      body: refusal("unauthorized", "No key, or a key that is unknown or revoked."),
    });
    for (const code of options.refusals ?? ["refused"]) {
      const entry = catalogue.get(code);
      answers.push({
        scenario: code,
        status: refusalStatus(code),
        request: { tool, input },
        body: refusal(code, entry?.meaning ?? `Refused (${code}).`, entry?.fix),
      });
    }
    out[tool] = answers;
  }
  return out;
}
