#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { recordedAnswers } from "./answers.js";
import type { ErrorCatalogue, Fixture, OpenApiDocument } from "./index.js";
import { startMockServer } from "./server.js";

/**
 * npx @seolyticize/mock [--port 4600] [--spec openapi.json|URL] [--errors errors.json|URL]
 *   [--fixtures dir] [--scenario tool=noop …] [--key sk_…] [--record]
 * The spec defaults to the live https://seolyticize.com/api/v1/openapi.json;
 * pass a saved copy for offline CI. A fixtures dir holds <tool>.json files.
 */
const { values } = parseArgs({
  options: {
    port: { type: "string", default: "4600" },
    spec: { type: "string", default: "https://seolyticize.com/api/v1/openapi.json" },
    fixtures: { type: "string" },
    key: { type: "string" },
    // GET /api/v1/errors, saved or live; defaults to the one beside a live spec.
    errors: { type: "string" },
    // tool=scenario, repeatable: create_client=noop, start_crawl=queued, add_keywords=plan_limit.
    scenario: { type: "string", multiple: true },
    // Print every tool's recorded answers as JSON and exit.
    record: { type: "boolean", default: false },
  },
});

const load = async (source: string) =>
  /^https?:/.test(source)
    ? await (await fetch(source)).json()
    : JSON.parse(await readFile(source, "utf8"));

const spec = (await load(values.spec)) as OpenApiDocument;
const errorsFrom =
  values.errors ??
  (/^https?:/.test(values.spec)
    ? values.spec.replace(/openapi\.json$/, "errors")
    : undefined);
const errors = errorsFrom
  ? ((await load(errorsFrom).catch(() => undefined)) as ErrorCatalogue | undefined)
  : undefined;

if (values.record) {
  console.log(JSON.stringify(recordedAnswers(spec, errors ? { errors } : {}), null, 2));
  process.exit(0);
}

const scenarios = Object.fromEntries(
  (values.scenario ?? []).map((pair) => pair.split("=", 2) as [string, string]),
);

const fixtures: Record<string, Fixture> = {};
if (values.fixtures) {
  for (const file of await readdir(values.fixtures)) {
    if (file.endsWith(".json"))
      fixtures[file.slice(0, -5)] = JSON.parse(
        await readFile(join(values.fixtures, file), "utf8"),
      );
  }
}

const mock = await startMockServer({
  spec,
  fixtures,
  scenarios,
  ...(errors ? { errors } : {}),
  port: Number(values.port),
  ...(values.key ? { apiKey: values.key } : {}),
});
console.log(
  `Seolyticize mock on ${mock.url}: SEOLYTICIZE_BASE_URL=${mock.url}, ${Object.keys(fixtures).length} fixtures.`,
);
