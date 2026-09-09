import { ManagementClient } from "../src/management/client.js";
import { ManagementError } from "../src/management/errors.js";
import type { ManagementFactory, ManagementUnderTest, ReportedManagementError } from "./management-adapter.js";

const TEST_API_SECRET = "test-api-secret";
const TEST_BEARER = "test-session-bearer";

class SdkManagementUnderTest implements ManagementUnderTest {
  private readonly client: ManagementClient;
  readonly results: unknown[] = [];
  readonly errors: ReportedManagementError[] = [];
  readonly warnings: string[] = [];

  constructor(baseUrl: string) {
    this.client = new ManagementClient({
      baseUrl,
      apiSecret: TEST_API_SECRET,
      bearerToken: TEST_BEARER,
    });
  }

  async invoke(method: string, args: Record<string, unknown>): Promise<void> {
    try {
      this.results.push(await this.call(method, args));
    } catch (error) {
      this.errors.push(toReported(error));
    }
  }

  private call(method: string, args: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case "capability":
        return this.client.capability();
      case "bots":
        return this.client.bots(args as never);
      case "bot":
        return this.client.bot(String(args["id"]));
      case "dialogue":
        return this.client.dialogue(args as never);
      case "command":
        return this.client.command(args as never);
      case "grant":
        return this.client.grant(String(args["targetId"]), args as never);
      default:
        return Promise.reject(new Error(`unknown management method: ${method}`));
    }
  }

  describe(): string {
    // A credential must not surface through the client's own rendering.
    return `${String(this.client)} ${JSON.stringify(this.client)}`;
  }
}

function toReported(error: unknown): ReportedManagementError {
  if (error instanceof ManagementError) {
    return {
      managementCode: error.code,
      retryable: error.retryable,
      accessLost: error.accessLost,
      message: error.message,
    };
  }
  return { message: error instanceof Error ? error.message : String(error) };
}

export const managementFactory: ManagementFactory = {
  create: ({ baseUrl }) => new SdkManagementUnderTest(baseUrl),
};
