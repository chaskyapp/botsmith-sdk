import { redactText } from "./redact.js";

/** An error the server described in its envelope. */
export class ChaskyApiError extends Error {
  readonly code: number;
  /** Stable, human-readable, for logs. NEVER flow control — that is `code`. */
  readonly description: string;
  readonly method: string;
  /** Seconds the server asked to wait. Only on a 429 (G11). */
  readonly retryAfter: number | undefined;

  constructor(code: number, description: string, method: string, retryAfter?: number) {
    super(`${method} failed: ${code} ${description}`);
    this.name = "ChaskyApiError";
    this.code = code;
    this.description = description;
    this.method = method;
    this.retryAfter = typeof retryAfter === "number" && retryAfter > 0 ? retryAfter : undefined;
  }
}

/** The request never produced an envelope: network, DNS, abort, bad JSON. */
export class ChaskyTransportError extends Error {
  override readonly cause: unknown;

  constructor(message: string, options: { cause: unknown; token: string }) {
    super(redactText(message, options.token));
    this.name = "ChaskyTransportError";
    this.cause = options.cause;
  }
}

/** Raised locally, before spending a request. */
export class ChaskyUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChaskyUsageError";
  }
}

export type ErrorClass = "terminal" | "business" | "transient";

/**
 * How long to wait before retrying: the backoff, or what the server asked
 * for in a 429 if that is longer. Waiting less only earns another 429.
 */
export function retryDelayMs(error: unknown, backoffMs: number): number {
  const seconds = error instanceof ChaskyApiError ? error.retryAfter : undefined;
  return seconds === undefined ? backoffMs : Math.max(backoffMs, seconds * 1000);
}

/**
 * Maps an error to what the SDK does with it (§10.2, G7).
 *
 * NOTE — a contract wrinkle resolved here. §10.2 classifies `403 BOT_SUSPENDED`
 * as terminal and `403 CHAT_FORBIDDEN` as business, which would require reading
 * `description`; but §10.1 forbids using `description` for flow control, and it
 * is right to, since the server does not declare it enumerated.
 *
 * The METHOD resolves it without touching the string. A 403 while polling means
 * the bot itself is barred — terminal. A 403 from a send means that one chat is
 * not ours — business, and the bot lives on. Same for 401 and 409: fatal to the
 * poller, reportable to a single call.
 */
export function classify(error: unknown, source: "poll" | "call"): ErrorClass {
  if (error instanceof ChaskyApiError) {
    // A 429 is "not yet", from any source: never terminal, never dropped (G11).
    if (error.code >= 500 || error.code === 429) return "transient";
    if (source === "poll" && (error.code === 401 || error.code === 403 || error.code === 409)) {
      return "terminal";
    }
    if (source === "call" && error.code === 401) return "terminal";
    return "business";
  }
  if (error instanceof ChaskyUsageError) return "business";
  return "transient";
}
