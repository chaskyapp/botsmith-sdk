import { readFile } from "node:fs/promises";
import type { BotFactory, BotUnderTest } from "./adapter.js";
import type { AdminFactory, AdminUnderTest } from "./admin-adapter.js";
import { FakeServer } from "./fake-server.js";
import { failure, matchHeaders, matchPartial, type Captures } from "./matchers.js";
import type { ConformanceCase, Failure, Json } from "./types.js";

/** Fixed test credential. Never a real token; cases refer to it as {token}. */
export const TEST_TOKEN = "bot:b1:" + "0".repeat(64);

const DEFAULT_TIMEOUT_MS = 5000;
/** After the exchanges run out, how long to watch for a request that should not come. */
const IDLE_GRACE_MS = 200;

export interface CaseResult {
  case: ConformanceCase;
  failures: Failure[];
}

export async function loadCase(path: string): Promise<ConformanceCase> {
  return JSON.parse(await readFile(path, "utf8")) as ConformanceCase;
}

export async function runCase(
  testCase: ConformanceCase,
  factory: BotFactory,
  managementFactory?: AdminFactory,
): Promise<CaseResult> {
  if (testCase.kind === "management") {
    if (!managementFactory) {
      return {
        case: testCase,
        failures: [failure("setup", "this case is a management case but no management factory was supplied")],
      };
    }
    return runManagementCase(testCase, managementFactory);
  }

  const server = new FakeServer(testCase.exchanges);
  await server.start();

  let bot: BotUnderTest | null = null;
  const failures: Failure[] = [];

  // A conformance runner executes untrusted code by definition: an SDK with a
  // bug is the whole point. An unhandled rejection from the bot under test must
  // fail THIS case and let the suite continue — otherwise one broken SDK hides
  // every case after it, which is exactly when the report matters most.
  let secondStartRejected = false;
  let stopDurationMs: number | undefined;
  let stopped = false;
  const crashes: string[] = [];
  const onCrash = (reason: unknown) => crashes.push(describe(reason));
  process.on("unhandledRejection", onCrash);
  process.on("uncaughtException", onCrash);

  try {
    bot = factory.create({
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
      limit: testCase.bot?.options?.limit,
      timeoutSeconds: testCase.bot?.options?.timeoutSeconds,
      handler: testCase.bot?.handler ?? { kind: "noop" },
    });
    await bot.start();

    if (testCase.bot?.startTwice) {
      // G1: the second start must fail locally. If it silently succeeds, the
      // SDK has two loops on one bot and is causing the very 409 it should be
      // reporting.
      try {
        await bot.start();
      } catch {
        secondStartRejected = true;
      }
    }

    const stopAfterMs = testCase.run?.stopAfterMs;
    if (stopAfterMs !== undefined) {
      await sleep(stopAfterMs);
      const startedStopping = Date.now();
      await bot.stop();
      stopDurationMs = Date.now() - startedStopping;
      stopped = true;
    } else {
      await waitForCompletion(bot, server, testCase.run?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    }
  } catch (error) {
    failures.push(failure("run", `the bot threw out of start(): ${describe(error)}`));
  } finally {
    try {
      if (!stopped) await bot?.stop();
    } catch {
      /* stopping must never mask a real failure */
    }
    await server.stop();
    process.off("unhandledRejection", onCrash);
    process.off("uncaughtException", onCrash);
  }

  for (const crash of crashes) {
    failures.push(failure("crash", `the bot threw and did not handle it: ${crash}`));
  }
  failures.push(...checkRequests(testCase, server));
  if (bot) failures.push(...checkAssertions(testCase, bot, { secondStartRejected, stopDurationMs }));
  return { case: testCase, failures };
}

/**
 * A management case invokes methods in order; nothing polls, so there is no
 * loop to wait on and no steady state. The exchange list and every matcher work
 * exactly as they do for the runtime — that reuse is why the two kinds share a
 * format at all.
 */
async function runManagementCase(
  testCase: ConformanceCase,
  factory: AdminFactory,
): Promise<CaseResult> {
  const server = new FakeServer(testCase.exchanges);
  await server.start();
  const failures: Failure[] = [];
  let client: AdminUnderTest | null = null;
  try {
    client = factory.create({ baseUrl: server.baseUrl });
    for (const call of testCase.calls ?? []) {
      await client.invoke(call.method, (call.args ?? {}) as Record<string, unknown>);
    }
  } catch (error) {
    failures.push(failure("run", `the client threw out of a call: ${describe(error)}`));
  } finally {
    await server.stop();
  }

  failures.push(...checkRequests(testCase, server));
  if (client) failures.push(...checkManagementAssertions(testCase, client));
  return { case: testCase, failures };
}

function checkManagementAssertions(testCase: ConformanceCase, client: AdminUnderTest): Failure[] {
  const failures: Failure[] = [];
  const want = testCase.assert;
  if (!want) return failures;

  for (const [i, expected] of (want.errorsReported ?? []).entries()) {
    const actual = client.errors[i];
    if (!actual) {
      failures.push(failure("assert.errorsReported", `expected an error at position ${i}, none was reported`));
      continue;
    }
    if (expected.managementCode !== undefined && actual.managementCode !== expected.managementCode) {
      failures.push(
        failure(
          "assert.errorsReported",
          `error #${i + 1}: expected code ${expected.managementCode}, got ${actual.managementCode}`,
        ),
      );
    }
    for (const field of ["retryable", "accessLost"] as const) {
      if (expected[field] !== undefined && actual[field] !== expected[field]) {
        failures.push(
          failure(
            "assert.errorsReported",
            `error #${i + 1}: expected ${field}=${expected[field]}, got ${actual[field]}`,
          ),
        );
      }
    }
  }
  if ((want.errorsReported?.length ?? 0) === 0 && client.errors.length > 0) {
    failures.push(
      failure("assert.errorsReported", `expected no errors, got ${JSON.stringify(client.errors.map((e) => e.managementCode ?? e.message))}`),
    );
  }

  if (want.createdBotId !== undefined) {
    const reported = client.results.some(
      (result) => (result as { botId?: string } | null)?.botId === want.createdBotId,
    );
    if (!reported) {
      failures.push(
        failure("assert.createdBotId", `expected the facade to report creating ${want.createdBotId}`),
      );
    }
  }

  if (want.resultContains !== undefined) {
    // Values, never field names: names are idiomatic per language.
    const encoded = JSON.stringify(client.results);
    for (const value of want.resultContains) {
      if (!encoded.includes(value)) {
        failures.push(failure("assert.resultContains", `the value ${JSON.stringify(value)} never reached the caller`));
      }
    }
  }

  if (want.secretReturnedOnce !== undefined) {
    const returned = client.results.some((result) => JSON.stringify(result ?? null).includes(want.secretReturnedOnce!));
    if (!returned) {
      failures.push(failure("assert.secretReturnedOnce", "the revealed token never reached the caller"));
    }
    // The one response carrying a live token is response-only by the server's
    // own design. If the SDK lets it reach a log line, an error, or its own
    // representation, it undoes the only protection built for it.
    const places: Record<string, string> = {
      errors: JSON.stringify(client.errors),
      warnings: JSON.stringify(client.warnings),
      repr: client.describe(),
    };
    for (const place of want.secretNotIn ?? []) {
      if (places[place]?.includes(want.secretReturnedOnce)) {
        failures.push(
          failure("assert.secretNotIn", `the revealed token LEAKED into ${place}; it must reach the return value only`),
        );
      }
    }
  }
  return failures;
}

async function waitForCompletion(bot: BotUnderTest, server: FakeServer, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (bot.stoppedItself) {
      // Even a stopped bot gets watched briefly: a bot that reports the error
      // and keeps polling is exactly the g7-409 failure this suite exists for.
      await sleep(IDLE_GRACE_MS);
      return;
    }
    if (server.exhausted) {
      await sleep(IDLE_GRACE_MS);
      return;
    }
    await sleep(10);
  }
}

function checkRequests(testCase: ConformanceCase, server: FakeServer): Failure[] {
  const failures: Failure[] = [];
  const captures: Captures = new Map();
  /** Per-request problems, collapsed at the end so one defect reads as one line. */
  const perRequest: { index: number; detail: string }[] = [];
  const note = (index: number, detail: string) => perRequest.push({ index, detail });

  const last = testCase.exchanges[testCase.exchanges.length - 1];
  const repeats = last?.repeat === true;
  // With a repeating tail, every poll past the declared list must still match
  // that last expectation — the bot may idle, but it may not idle differently.
  const total = repeats ? Math.max(testCase.exchanges.length, server.observed.length) : testCase.exchanges.length;

  for (let i = 0; i < total; i++) {
    const expected = (testCase.exchanges[i] ?? last)!.expect;
    const actual = server.observed[i];
    if (!actual) {
      note(i + 1, `expected ${describeExpected(expected)}, but the SDK never sent it`);
      continue;
    }
    if (expected.method && expected.method !== actual.method) {
      note(i + 1, `expected method ${expected.method}, got ${actual.method}`);
    }
    // The observed path carries the query string; the case declares them
    // separately so a query can be partially matched like a body.
    const [actualPath, actualQuery = ""] = actual.path.split("?");
    if (expected.path) {
      const want = expected.path.replaceAll("{token}", TEST_TOKEN);
      if (want !== actualPath) {
        note(i + 1, `expected path ${redact(want)}, got ${redact(actualPath!)}`);
      }
    }
    if (expected.query) {
      const observed: Record<string, Json> = {};
      for (const [key, value] of new URLSearchParams(actualQuery)) observed[key] = value;
      const reason = matchPartial(expected.query as Record<string, Json>, observed, captures, "query");
      if (reason) note(i + 1, reason);
    }
    if (expected.headers) {
      const reason = matchHeaders(expected.headers, actual.headers, captures);
      if (reason) note(i + 1, reason);
    }
    if (expected.body) {
      const reason = matchPartial(expected.body as Record<string, Json>, actual.body, captures, "body");
      if (reason) note(i + 1, reason);
    }
  }

  const byDetail = new Map<string, number[]>();
  for (const { index, detail } of perRequest) {
    (byDetail.get(detail) ?? byDetail.set(detail, []).get(detail)!).push(index);
  }
  for (const [detail, indexes] of byDetail) {
    const where =
      indexes.length === 1
        ? `request #${indexes[0]}`
        : `requests #${indexes[0]}-#${indexes[indexes.length - 1]} (${indexes.length} times)`;
    failures.push(failure(where, detail));
  }

  if (server.extras.length > 0) {
    const shown = server.extras.slice(0, 3).map((e) => `${e.method} ${redact(e.path)}`);
    const rest = server.extras.length - shown.length;
    failures.push(
      failure(
        "unexpected requests",
        `the SDK sent ${server.extras.length} request(s) after the last declared exchange ` +
          `(${shown.join(", ")}${rest > 0 ? `, +${rest} more` : ""}). ` +
          `The exchange list is exhaustive: nothing may follow it.`,
      ),
    );
  }
  return failures;
}

interface Lifecycle {
  secondStartRejected: boolean;
  stopDurationMs: number | undefined;
}

function checkAssertions(testCase: ConformanceCase, bot: BotUnderTest, lifecycle: Lifecycle): Failure[] {
  const failures: Failure[] = [];
  const want = testCase.assert;
  if (!want) return failures;

  if (want.secondStartRejected !== undefined && want.secondStartRejected !== lifecycle.secondStartRejected) {
    failures.push(
      failure(
        "assert.secondStartRejected",
        want.secondStartRejected
          ? "the second start() succeeded; the SDK now has two polls on one bot"
          : "the second start() was rejected, but this case expected it to be allowed",
      ),
    );
  }

  if (want.stoppedWithinMs !== undefined) {
    if (lifecycle.stopDurationMs === undefined) {
      failures.push(
        failure("assert.stoppedWithinMs", "this case asserts on stop() but never called it; add run.stopAfterMs"),
      );
    } else if (lifecycle.stopDurationMs > want.stoppedWithinMs) {
      failures.push(
        failure(
          "assert.stoppedWithinMs",
          `stop() took ${lifecycle.stopDurationMs}ms, over the ${want.stoppedWithinMs}ms budget — ` +
            `it is waiting out the server's response instead of aborting the request`,
        ),
      );
    }
  }

  if (want.botStopped !== undefined && want.botStopped !== bot.stoppedItself) {
    failures.push(
      failure(
        "assert.botStopped",
        want.botStopped
          ? "expected the bot to stop on its own, but it was still running"
          : "expected the bot to keep running, but it stopped on its own",
      ),
    );
  }

  for (const run of want.handlerRuns ?? []) {
    const actual = bot.handlerRuns.get(run.updateId) ?? 0;
    if (actual !== run.times) {
      failures.push(
        failure("assert.handlerRuns", `update ${run.updateId}: expected ${run.times} run(s), got ${actual}`),
      );
    }
  }

  for (const [i, expected] of (want.errorsReported ?? []).entries()) {
    const actual = bot.errors[i];
    if (!actual) {
      failures.push(failure("assert.errorsReported", `expected an error at position ${i}, none was reported`));
      continue;
    }
    if (expected.code !== undefined && actual.code !== expected.code) {
      failures.push(
        failure("assert.errorsReported", `error #${i + 1}: expected code ${expected.code}, got ${actual.code}`),
      );
    }
    if (expected.notContains) {
      const needle = expected.notContains.replaceAll("{token}", TEST_TOKEN);
      if (actual.message.includes(needle)) {
        failures.push(
          failure(
            "assert.errorsReported",
            `error #${i + 1} LEAKS the token. An error crossing the SDK boundary must be redacted first.`,
          ),
        );
      }
    }
  }

  for (const warning of want.warnings ?? []) {
    if (!bot.warnings.some((w) => w.toLowerCase().includes(warning.contains.toLowerCase()))) {
      failures.push(
        failure("assert.warnings", `expected a warning containing ${JSON.stringify(warning.contains)}, got ${
          bot.warnings.length ? JSON.stringify(bot.warnings) : "none"
        }`),
      );
    }
  }
  return failures;
}

function describeExpected(expected: { method?: string; path?: string }): string {
  return `${expected.method ?? "POST"} ${redact(expected.path ?? "?")}`;
}

/** The runner prints paths, and paths carry the token. Redact before printing. */
function redact(text: string): string {
  return text.replaceAll(TEST_TOKEN, "<TOKEN>").replace(/\/bot[^/]+\//, "/bot<TOKEN>/");
}

function describe(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
