// Mirrors ../../conformance/SCHEMA.md. If the two disagree, SCHEMA.md wins:
// the cases are shared across three languages and this file is one reader.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

export interface ExpectedRequest {
  method?: string;
  path?: string;
  body?: Record<string, Json>;
  headers?: Record<string, string>;
}

export interface CannedResponse {
  status?: number;
  body?: Json;
  /** The fake fails the connection instead of answering. May contain {url}. */
  transportError?: string;
  delayMs?: number;
}

export interface Exchange {
  expect: ExpectedRequest;
  respond: CannedResponse;
  /**
   * Only valid on the LAST exchange. Marks it as the idle steady state: a bot
   * that is still alive keeps long-polling forever, and those polls are correct
   * behaviour, not surplus. Terminal cases (401, 409) deliberately omit it, so
   * exhaustiveness still catches a bot that should have stopped.
   */
  repeat?: boolean;
}

export interface HandlerSpec {
  kind: "reply" | "noop";
  throwOnUpdateIds?: number[];
  replyText?: string;
}

export interface Assertions {
  botStopped?: boolean;
  handlerRuns?: { updateId: number; times: number }[];
  errorsReported?: { code?: number; notContains?: string }[];
  warnings?: { contains: string }[];
}

export interface ConformanceCase {
  id: string;
  contractVersion: string;
  guarantee: string;
  title: string;
  why: string;
  bot: {
    transport: "polling";
    options?: { limit?: number; timeoutSeconds?: number };
    handler: HandlerSpec;
  };
  exchanges: Exchange[];
  assert?: Assertions;
  run?: { timeoutMs?: number };
}

/** A request as the fake actually saw it. */
export interface ObservedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Json;
}

export interface Failure {
  where: string;
  detail: string;
}
