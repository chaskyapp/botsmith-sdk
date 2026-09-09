import { readFile } from "node:fs/promises";
import type { BotFactory, BotUnderTest } from "./adapter.js";
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

export async function runCase(testCase: ConformanceCase, factory: BotFactory): Promise<CaseResult> {
  const server = new FakeServer(testCase.exchanges);
  await server.start();

  let bot: BotUnderTest | null = null;
  const failures: Failure[] = [];

  // A conformance runner executes untrusted code by definition: an SDK with a
  // bug is the whole point. An unhandled rejection from the bot under test must
  // fail THIS case and let the suite continue — otherwise one broken SDK hides
  // every case after it, which is exactly when the report matters most.
  const crashes: string[] = [];
  const onCrash = (reason: unknown) => crashes.push(describe(reason));
  process.on("unhandledRejection", onCrash);
  process.on("uncaughtException", onCrash);

  try {
    bot = factory.create({
      baseUrl: server.baseUrl,
      token: TEST_TOKEN,
      limit: testCase.bot.options?.limit,
      timeoutSeconds: testCase.bot.options?.timeoutSeconds,
      handler: testCase.bot.handler,
    });
    await bot.start();
    await waitForCompletion(bot, server, testCase.run?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  } catch (error) {
    failures.push(failure("run", `the bot threw out of start(): ${describe(error)}`));
  } finally {
    try {
      await bot?.stop();
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
  if (bot) failures.push(...checkAssertions(testCase, bot));
  return { case: testCase, failures };
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

  for (let i = 0; i < testCase.exchanges.length; i++) {
    const expected = testCase.exchanges[i]!.expect;
    const actual = server.observed[i];
    if (!actual) {
      failures.push(failure(`request #${i + 1}`, `expected ${describeExpected(expected)}, but the SDK never sent it`));
      continue;
    }
    if (expected.method && expected.method !== actual.method) {
      failures.push(failure(`request #${i + 1}`, `expected method ${expected.method}, got ${actual.method}`));
    }
    if (expected.path) {
      const want = expected.path.replaceAll("{token}", TEST_TOKEN);
      if (want !== actual.path) {
        failures.push(failure(`request #${i + 1}`, `expected path ${redact(want)}, got ${redact(actual.path)}`));
      }
    }
    if (expected.headers) {
      const reason = matchHeaders(expected.headers, actual.headers, captures);
      if (reason) failures.push(failure(`request #${i + 1}`, reason));
    }
    if (expected.body) {
      const reason = matchPartial(expected.body as Record<string, Json>, actual.body, captures, "body");
      if (reason) failures.push(failure(`request #${i + 1}`, reason));
    }
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

function checkAssertions(testCase: ConformanceCase, bot: BotUnderTest): Failure[] {
  const failures: Failure[] = [];
  const want = testCase.assert;
  if (!want) return failures;

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
