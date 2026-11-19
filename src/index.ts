/**
 * A stand-in for the Seolyticize API, for tests and local development. It
 * answers from the real OpenAPI document: unknown tools are 404, missing
 * required fields 400, no key 401, all in the same refusal shape as the real
 * API ({ error, code, requestId }), and a call that passes answers your
 * fixture as the API does: { ok, outcome (writes), data, meta }. A scenario
 * makes a tool answer noop, partial, skipped, declined, a refusal, or 202
 * (collected with its Idempotency-Key, as the SDK does). /api/collect accepts
 * events and keeps them.
 *
 * Use mock.fetch as the fetch of @seolyticize/sdk's createClient, or as
 * @seolyticize/node's transport, with no server at all; or run
 * `npx @seolyticize/mock` for a server on a port.
 */
import {
  accepted,
  declined,
  OUTCOME_REASONS,
  refusal,
  refusalStatus,
  success,
  toolsOf,
  type ErrorCatalogue,
  type OpenApiDocument,
  type Outcome,
} from "./answers.js";

export type { ErrorCatalogue, OpenApiDocument, Outcome } from "./answers.js";

/** A tool's answer: data, or a function of the call's input. */
export type Fixture =
  ((input: Record<string, unknown>) => unknown) | Record<string, unknown> | unknown[];

/**
 * How a tool answers: an outcome (applied is the default for a write), queued
 * (202, then the answer when collected), declined (409 ok:false), or any other
 * string, which is a refusal code answered 402, 409 or 422 as the API would.
 */
export type Scenario = Outcome | "declined" | (string & {});

export type MockOptions = {
  spec: OpenApiDocument;
  /** Answers by tool name; a tool without one answers {}. */
  fixtures?: Record<string, Fixture>;
  /** How each named tool answers; the X-Mock-Scenario header does the same per call. */
  scenarios?: Record<string, Scenario>;
  /** GET /api/v1/errors, so a refusal carries the real sentence and fix for its code. */
  errors?: ErrorCatalogue;
  /** When given, only this bearer key is accepted; otherwise any key is. */
  apiKey?: string;
};

export type MockCall = { tool: string; input: Record<string, unknown> };

export type Mock = {
  /** A fetch that answers as the API would. */
  fetch: typeof fetch;
  /** Every tool call that passed, in order (a 202 and its collection count once). */
  calls: MockCall[];
  /** Every body posted to /api/collect. */
  events: Array<Record<string, unknown>>;
};

const OUTCOMES = new Set(Object.keys(OUTCOME_REASONS));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "req_mock",
      ...headers,
    },
  });

export function createMock(options: MockOptions): Mock {
  const calls: MockCall[] = [];
  const events: Array<Record<string, unknown>> = [];
  const tools = toolsOf(options.spec);
  const catalogue = new Map(
    (options.errors?.errors ?? []).map((e) => [e.code, e] as const),
  );
  // Keys a 202 handed out, not yet collected.
  const pending = new Set<string>();
  let nextKey = 0;
  const refuse = (status: number, code: string, error: string) =>
    json(refusal(code, error), status);
  const refuseAs = (code: string) => {
    const entry = catalogue.get(code);
    return json(
      refusal(code, entry?.meaning ?? `Refused by the mock (${code}).`, entry?.fix),
      refusalStatus(code),
    );
  };

  async function answer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/openapi.json") return json(options.spec);
    if (url.pathname === "/api/v1/errors" && options.errors) return json(options.errors);
    if (url.pathname === "/api/collect" && request.method === "POST") {
      const body = (await request.json().catch(() => null)) as Record<
        string,
        unknown
      > | null;
      if (!body || typeof body.k !== "string")
        return refuse(400, "invalid_input", "k is required.");
      events.push(body);
      return json({ visit: "v1.mock" }, 202);
    }
    if (!url.pathname.startsWith("/api/v1/"))
      return refuse(404, "not_found", "Not found.");
    const key = /^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!key || (options.apiKey && key !== options.apiKey))
      return refuse(401, "unauthorized", "No key, or a key that is unknown or revoked.");
    if (url.pathname === "/api/v1/tools" && request.method === "GET") {
      return json({
        tools: [...tools].map(([name, tool]) => ({
          name,
          title: tool.title,
          readOnly: tool.readOnly,
          path: `/api/v1/tools/${name}`,
        })),
      });
    }
    const name = /^\/api\/v1\/tools\/([a-z0-9_]+)$/.exec(url.pathname)?.[1];
    const tool = name ? tools.get(name) : undefined;
    if (!name || !tool)
      return refuse(404, "unknown_tool", `No tool named ${name ?? url.pathname}.`);
    if (request.method !== "POST") return refuse(405, "method_not_allowed", "Use POST.");
    const input = (await request.json().catch(() => undefined)) as unknown;
    if (input === null || typeof input !== "object" || Array.isArray(input))
      return refuse(400, "invalid_input", `The body for ${name} must be a JSON object.`);
    const body = input as Record<string, unknown>;
    const missing = tool.required.filter((field) => body[field] === undefined);
    if (missing.length)
      return refuse(
        400,
        "invalid_input",
        `Invalid input for ${name} — ${missing.map((field) => `${field}: Required`).join("; ")}`,
      );
    // A test asks for a refusal by code: X-Mock-Refuse: plan_limit.
    const refused = request.headers.get("x-mock-refuse");
    if (refused) return refuseAs(refused);
    const presented = request.headers.get("idempotency-key");
    const collecting = presented !== null && pending.delete(presented);
    const scenario =
      request.headers.get("x-mock-scenario") ?? options.scenarios?.[name] ?? "applied";
    if (scenario === "queued" && !collecting) {
      const asyncKey = `call_mock_${++nextKey}`;
      pending.add(asyncKey);
      return json(accepted(asyncKey), 202, { "retry-after": "5" });
    }
    if (scenario !== "declined" && scenario !== "queued" && !OUTCOMES.has(scenario))
      return refuseAs(scenario);
    calls.push({ tool: name, input: body });
    if (scenario === "declined")
      return json(
        declined("not_connected", "Nothing is connected for this (mock)."),
        refusalStatus("not_connected"),
      );
    const fixture = options.fixtures?.[name];
    const data = typeof fixture === "function" ? await fixture(body) : (fixture ?? {});
    // A collected 202 is the call's own answer: applied, for a write.
    const outcome = scenario === "queued" ? "applied" : (scenario as Outcome);
    return json(success(data, tool.readOnly ? undefined : outcome));
  }

  const mockFetch = async (input: string | URL | Request, init?: RequestInit) =>
    answer(
      new Request(
        input instanceof Request ? input : new URL(String(input), "http://mock.local"),
        init,
      ),
    );
  return { fetch: mockFetch as typeof fetch, calls, events };
}
