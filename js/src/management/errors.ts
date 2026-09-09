/**
 * Management errors are a SEPARATE type from the runtime's, and that separation
 * is requirement R-B in §6 of the contract, not a stylistic choice.
 *
 * A `409` means STOP on the runtime (another instance evicted you) and RE-READ
 * AND RETRY here. With one shared error type, an `if (err.code === 409) retry()`
 * written for management and reused in the runtime puts two bots into an
 * eviction war. With two types, that `if` does not compile against the wrong
 * surface.
 */

/** The envelope's string codes. Unlike the runtime, the code IS a string here. */
export type ManagementCode =
  | "INVALID_INPUT"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "STALE_STATE"
  | "QUOTA_EXCEEDED"
  | "TOO_MANY_ATTEMPTS"
  | "UNAVAILABLE"
  | "RECOVERY_REQUIRED"
  | "UNKNOWN";

export class ManagementError extends Error {
  readonly code: ManagementCode;
  readonly status: number;
  readonly method: string;

  constructor(code: ManagementCode, status: number, method: string) {
    super(`${method} failed: ${code}`);
    this.name = "ManagementError";
    this.code = code;
    this.status = status;
    this.method = method;
  }

  /**
   * True when re-reading the current revision and retrying is the right move.
   *
   * `STALE_STATE` is the whole point of the dialogue's optimistic concurrency:
   * someone else advanced it, so read `dialogue()` again and resend with the
   * revision you just saw.
   */
  get retryable(): boolean {
    return this.code === "STALE_STATE" || this.code === "UNAVAILABLE";
  }

  /**
   * True only when administration is actually gone.
   *
   * `QUOTA_EXCEEDED` and `TOO_MANY_ATTEMPTS` are deliberately NOT `FORBIDDEN`
   * on the server — its own comment explains why: a caller treats 403 as "your
   * administration was revoked" and tears the session down, while a quota
   * reached is normal and recoverable. Reporting either as lost access lies to
   * the user about what happened.
   */
  get accessLost(): boolean {
    return this.code === "UNAUTHORIZED" || this.code === "FORBIDDEN";
  }
}

export class ManagementTransportError extends Error {
  override readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "ManagementTransportError";
    this.cause = cause;
  }
}

const STATUS_TO_CODE: Record<number, ManagementCode> = {
  400: "INVALID_INPUT",
  401: "UNAUTHORIZED",
  403: "FORBIDDEN",
  404: "NOT_FOUND",
  409: "STALE_STATE",
  422: "QUOTA_EXCEEDED",
  429: "TOO_MANY_ATTEMPTS",
  503: "UNAVAILABLE",
};

/** Prefer the envelope's code; fall back to the status when it is absent. */
export function codeFor(envelopeCode: unknown, status: number): ManagementCode {
  if (typeof envelopeCode === "string" && envelopeCode) return envelopeCode as ManagementCode;
  return STATUS_TO_CODE[status] ?? "UNKNOWN";
}
