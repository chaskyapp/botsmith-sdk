/**
 * A deliberately naive bot. NOT the SDK, and never shipped.
 *
 * This is what an author writes by hand after reading the endpoint list and
 * nothing else: advance the offset only on success, no deduplication, one
 * idempotency key reused forever, no redaction, no clamping, retry everything.
 *
 * It exists so the runner can be trusted. A runner that has never failed a case
 * is not a tested runner — it might be reporting PASS because it checks nothing.
 * Every case in the suite must FAIL against this fixture, each for its own
 * reason, and the reasons double as a demonstration of what the cases buy.
 */
import type { BotFactory, BotUnderTest, BotUnderTestOptions, ReportedError } from "../adapter.js";
import type { HandlerSpec } from "../types.js";

class NaiveBot implements BotUnderTest {
  private running = false;
  private loop: Promise<void> | null = null;
  private offset = 0;
  /** One key for the whole process: the exact mistake §3.4 warns about. */
  private readonly key = "fixed-key-0001";

  stoppedItself = false;
  readonly handlerRuns = new Map<number, number>();
  readonly errors: ReportedError[] = [];
  readonly warnings: string[] = [];

  constructor(private readonly options: BotUnderTestOptions) {}

  async start(): Promise<void> {
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    await this.loop?.catch(() => {});
  }

  private url(method: string): string {
    return `${this.options.baseUrl}/bot${this.options.token}/${method}`;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let updates: { update_id: number; message?: { chat: { id: string }; text: string } }[] = [];
      try {
        // No clamping: whatever the author passed goes straight out.
        const body = {
          offset: this.offset,
          limit: this.options.limit ?? 100,
          timeout: this.options.timeoutSeconds ?? 0,
        };
        const res = await fetch(this.url("getUpdates"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        const envelope = (await res.json()) as { ok: boolean; result?: unknown; error_code?: number; description?: string };
        if (!envelope.ok) {
          // Everything is transient here, including 401 and 409.
          this.errors.push({ code: envelope.error_code, message: `${envelope.error_code} ${envelope.description}` });
          await sleep(50);
          continue;
        }
        // Guarded only so a wrong-shaped body fails the CASE instead of killing
        // the process. The naive bot is meant to be wrong, not to be a crash.
        updates = Array.isArray(envelope.result) ? (envelope.result as typeof updates) : [];
      } catch (error) {
        // No redaction: the URL, and therefore the token, goes straight through.
        this.errors.push({ message: error instanceof Error ? `${error.message} ${this.url("getUpdates")}` : String(error) });
        await sleep(50);
        continue;
      }

      for (const update of updates) {
        // No deduplication.
        this.handlerRuns.set(update.update_id, (this.handlerRuns.get(update.update_id) ?? 0) + 1);
        try {
          await this.handle(update, this.options.handler);
        } catch {
          // The offset does NOT advance past a failed handler. This is the bug.
          return;
        }
        this.offset = update.update_id + 1;
      }
    }
  }

  private async handle(
    update: { update_id: number; message?: { chat: { id: string }; text: string } },
    handler: HandlerSpec,
  ): Promise<void> {
    if (handler.throwOnUpdateIds?.includes(update.update_id)) throw new Error("handler failed");
    if (handler.kind === "noop" || !update.message) return;
    await fetch(this.url("sendMessage"), {
      method: "POST",
      headers: { "content-type": "application/json", "Idempotency-Key": this.key },
      body: JSON.stringify({ chat_id: update.message.chat.id, text: handler.replyText ?? update.message.text }),
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const factory: BotFactory = {
  create: (options) => new NaiveBot(options),
};
