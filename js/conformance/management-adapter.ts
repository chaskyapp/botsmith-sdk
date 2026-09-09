/**
 * The contract between the runner and a management client under test.
 *
 * Separate from BotUnderTest because the two surfaces are separate: one polls,
 * the other answers calls. Merging them here would be the same mistake R-A and
 * R-B in §6 of the contract exist to prevent, one layer up.
 */
export interface ReportedManagementError {
  /** The envelope's string code, e.g. "STALE_STATE". */
  managementCode?: string | undefined;
  /** Whether re-reading and retrying is the right response. */
  retryable?: boolean | undefined;
  /** Whether this means administration was actually revoked. */
  accessLost?: boolean | undefined;
  message: string;
}

export interface ManagementUnderTest {
  /** Invoke one client method. Resolves with its result or records the error. */
  invoke(method: string, args: Record<string, unknown>): Promise<void>;
  /** Whatever each call returned, in order. */
  readonly results: readonly unknown[];
  readonly errors: readonly ReportedManagementError[];
  readonly warnings: readonly string[];
  /** How the client renders itself — must never contain a credential. */
  describe(): string;
}

export interface ManagementFactory {
  create(options: { baseUrl: string }): ManagementUnderTest;
}
