/**
 * A deliberately wrong management client. NOT the SDK, and never shipped.
 *
 * It makes the single mistake m1 exists to catch: sending `null` for an unset
 * optional instead of omitting the field. That is what a JSON serialiser does
 * by default in most languages, and the server answers 400 INVALID_INPUT.
 *
 * It exists so the management half of the runner can be trusted. A runner that
 * has never failed a case is not a tested runner — it might report PASS because
 * it checks nothing.
 */
import type {
  ManagementFactory,
  ManagementUnderTest,
  ReportedManagementError,
} from "../management-adapter.js";

class BrokenManagementClient implements ManagementUnderTest {
  readonly results: unknown[] = [];
  readonly errors: ReportedManagementError[] = [];
  readonly warnings: string[] = [];

  constructor(private readonly baseUrl: string) {}

  async invoke(method: string, args: Record<string, unknown>): Promise<void> {
    const path = method === "command" ? "/commands" : `/${method}`;
    // Every optional is spelled out as null rather than omitted.
    const body = {
      operationID: "00000000-0000-4000-8000-000000000000",
      expectedRevision: args["expectedRevision"] ?? 0,
      command: args["command"] ?? null,
      value: args["value"] ?? null,
      botID: args["botID"] ?? null,
      expectedCredentialVersion: args["expectedCredentialVersion"] ?? null,
    };
    try {
      const response = await fetch(`${this.baseUrl}/bot-management${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "X-Secret": "test-api-secret" },
        body: JSON.stringify(body),
      });
      const envelope = (await response.json()) as { ok?: boolean; data?: unknown; error?: { code?: string } };
      if (envelope.ok) {
        this.results.push(envelope.data);
      } else {
        // No classification either: every failure looks the same.
        this.errors.push({ message: envelope.error?.code ?? "unknown" });
      }
    } catch (error) {
      this.errors.push({ message: error instanceof Error ? error.message : String(error) });
    }
  }

  describe(): string {
    return "BrokenManagementClient";
  }
}

export const managementFactory: ManagementFactory = {
  create: ({ baseUrl }) => new BrokenManagementClient(baseUrl),
};
