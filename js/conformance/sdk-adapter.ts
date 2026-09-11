/**
 * Binds @chasky/botsmith-sdk to the conformance runner.
 *
 * It lives here and not in src/ on purpose: it is test scaffolding, and the
 * publishable package must not carry it (R-C/R-D in §6 of the contract).
 */
import { createBot, type Bot } from "../src/bot.js";
import { ChaskyApiError } from "../src/errors.js";
import { polling } from "../src/polling.js";
import type { BotFactory, BotUnderTest, BotUnderTestOptions, ReportedError } from "./adapter.js";

class SdkBotUnderTest implements BotUnderTest {
  private readonly bot: Bot;

  stoppedItself = false;
  readonly handlerRuns = new Map<number, number>();
  readonly errors: ReportedError[] = [];
  readonly warnings: string[] = [];

  constructor(options: BotUnderTestOptions) {
    const spec = options.handler;

    this.bot = createBot({
      token: options.token,
      baseUrl: options.baseUrl,
      transport: polling({
        limit: options.limit,
        timeoutSeconds: options.timeoutSeconds,
        // Short so a case that exercises a retry finishes inside its timeout.
        retryBaseMs: 20,
        retryMaxMs: 200,
      }),
      onWarning: (message) => this.warnings.push(message),
      allowInsecureTransport: true, // the fake server is plain http on loopback
    });

    this.bot.on("text", async (ctx) => {
      const id = ctx.update.updateId;
      this.handlerRuns.set(id, (this.handlerRuns.get(id) ?? 0) + 1);
      if (spec.throwOnUpdateIds?.includes(id)) throw new Error(`handler failed on update ${id}`);
      if (spec.kind === "noop") return;
      await ctx.reply(spec.replyText ?? ctx.message.text);
    });

    this.bot.onError((error) => this.errors.push(toReported(error)));
    this.bot.onFatal((error) => {
      // A fatal is also an error the author sees: cases assert on it by position
      // in `errors`, and hiding it here would make those assertions untestable.
      this.errors.push(toReported(error));
      this.stoppedItself = true;
    });
  }

  start(): Promise<void> {
    // Deliberately not caught: a second start() must reject, and the runner
    // needs to see it reject (G1).
    return this.bot.start();
  }

  stop(): Promise<void> {
    return this.bot.stop();
  }
}

function toReported(error: unknown): ReportedError {
  if (error instanceof ChaskyApiError) return { code: error.code, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}

export const factory: BotFactory = {
  create: (options) => new SdkBotUnderTest(options),
};
