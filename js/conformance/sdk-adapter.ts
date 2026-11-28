/**
 * Binds @chasky/botsmith-sdk to the conformance runner.
 *
 * It lives here and not in src/ on purpose: it is test scaffolding, and the
 * publishable package must not carry it (R-C/R-D in §6 of the contract).
 */
import { mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBot, type Bot } from "../src/bot.js";
import { fileFromPath } from "../src/files.js";
import { ChaskyApiError } from "../src/errors.js";
import { polling } from "../src/polling.js";
import type { Attachment } from "../src/types.js";
import type { BotFactory, BotUnderTest, BotUnderTestOptions, ReportedError } from "./adapter.js";
import type { Json } from "./types.js";

class SdkBotUnderTest implements BotUnderTest {
  private readonly bot: Bot;

  stoppedItself = false;
  readonly handlerRuns = new Map<number, number>();
  readonly errors: ReportedError[] = [];
  readonly warnings: string[] = [];
  readonly attachmentsSeen: Json[] = [];
  private readonly scratch: string | undefined;

  constructor(options: BotUnderTestOptions) {
    const spec = options.handler;
    let documentPath: string | undefined;
    if (spec.replyDocument) {
      // Sparse: the size is what the case is about, and a 100 MB file of holes
      // costs no disk and no time to create.
      this.scratch = mkdtempSync(join(tmpdir(), "botsmith-conformance-"));
      documentPath = join(this.scratch, spec.replyDocument.fileName);
      writeFileSync(documentPath, "");
      truncateSync(documentPath, spec.replyDocument.bytes);
    }

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

    // Counted in the catch-all hook, so an update kind the SDK has no type for
    // is counted too (G10).
    this.bot.on("update", (update) => {
      this.handlerRuns.set(update.updateId, (this.handlerRuns.get(update.updateId) ?? 0) + 1);
    });
    this.bot.on("text", async (ctx) => {
      const id = ctx.update.updateId;
      if (spec.throwOnUpdateIds?.includes(id)) throw new Error(`handler failed on update ${id}`);
      if (spec.kind === "noop") return;
      if (spec.replyDocument && documentPath) {
        const { fileName, caption } = spec.replyDocument;
        await ctx.replyWithDocument(fileFromPath(documentPath, fileName), caption ? { caption } : {});
        return;
      }
      const mentions = spec.mentionBack
        ? Object.fromEntries((ctx.message.mentions ?? []).map((m) => [m.name, m.userId]))
        : undefined;
      await ctx.reply(spec.replyText ?? ctx.message.text, mentions ? { mentions } : {});
    });

    if (spec.recordAttachments) {
      this.bot.on("attachment", async (ctx) => {
        const attachments: Json[] = [];
        for (const attachment of ctx.message.attachments ?? []) {
          const seen = wireAttachment(attachment);
          if (spec.downloadAttachments) seen["downloadedBytes"] = await countBytes(await ctx.client.download(attachment));
          attachments.push(seen);
        }
        // Back into wire names, so the case can compare one shape across
        // languages (SCHEMA.md, attachmentsSeen).
        this.attachmentsSeen.push({
          updateId: ctx.update.updateId,
          text: ctx.message.text,
          caption: ctx.message.caption ?? "",
          attachmentsTruncated: ctx.message.attachmentsTruncated ?? false,
          attachments,
        });
      });
    }

    for (const [name, text] of Object.entries(spec.commands ?? {})) {
      this.bot.command(name, async (ctx) => {
        await ctx.reply(text);
      });
    }

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

  async stop(): Promise<void> {
    await this.bot.stop();
    if (this.scratch) rmSync(this.scratch, { recursive: true, force: true });
  }
}

function wireAttachment(a: Attachment): Record<string, Json> {
  const wire: Record<string, Json> = {
    file_id: a.fileId,
    kind: a.kind,
    file_name: a.fileName,
    mime_type: a.mimeType,
    file_size: a.fileSize,
    url: a.url,
  };
  if (a.width !== undefined) wire["width"] = a.width;
  if (a.height !== undefined) wire["height"] = a.height;
  if (a.duration !== undefined) wire["duration"] = a.duration;
  return wire;
}

async function countBytes(stream: ReadableStream<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of stream) total += chunk.byteLength;
  return total;
}

function toReported(error: unknown): ReportedError {
  if (error instanceof ChaskyApiError) return { code: error.code, message: error.message };
  return { message: error instanceof Error ? error.message : String(error) };
}

export const factory: BotFactory = {
  create: (options) => new SdkBotUnderTest(options),
};
