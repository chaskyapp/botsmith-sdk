import type { HandlerSpec } from "./types.js";

/**
 * The contract between the conformance runner and an SDK under test.
 *
 * The runner is written against this interface and nothing else, so it exists
 * before the SDK does and tells the SDK what to expose. Keeping it this thin is
 * deliberate: anything richer would let a case assert something idiomatic, and
 * cases must only ever verify observable behaviour (§3 of 01-organization.md).
 */
export interface ReportedError {
  /** Envelope error_code when the failure came from the API, else undefined. */
  code?: number;
  message: string;
}

export interface BotUnderTest {
  /** Resolves once polling has begun. Does not wait for the bot to finish. */
  start(): Promise<void>;
  /** Aborts any in-flight poll and returns once the bot is idle. */
  stop(): Promise<void>;

  /** True when the bot stopped on its own — a terminal error, not stop(). */
  readonly stoppedItself: boolean;
  /** How many times the handler ran, keyed by update_id. */
  readonly handlerRuns: ReadonlyMap<number, number>;
  /** Errors surfaced to the author, in order, already redacted. */
  readonly errors: readonly ReportedError[];
  /** Warnings surfaced to the author, in order. */
  readonly warnings: readonly string[];
}

export interface BotUnderTestOptions {
  baseUrl: string;
  token: string;
  limit?: number;
  timeoutSeconds?: number;
  handler: HandlerSpec;
}

export interface BotFactory {
  create(options: BotUnderTestOptions): BotUnderTest;
}

/**
 * Where the runner looks for the SDK's adapter. The SDK provides this module;
 * until it exists, `--factory` points the runner at a fixture instead.
 */
export const DEFAULT_FACTORY = "../src/conformance-adapter.js";
