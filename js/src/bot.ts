import { ChaskyBotClient, type ChaskyBotClientOptions } from "./client.js";
import { ChaskyUsageError, classify } from "./errors.js";
import { polling, sleep, type Transport } from "./polling.js";
import type { BotMessage, ChatID, MessageID, Update } from "./types.js";

export interface Context {
  readonly update: Update;
  readonly message: BotMessage;
  readonly chatId: ChatID;
  readonly client: ChaskyBotClient;
  /** sendMessage to this update's chat, with a managed Idempotency-Key. */
  reply(text: string, options?: { replyToMessageId?: MessageID }): Promise<BotMessage>;
  /** Explicit on purpose — the runtime never sends a chat action by itself. */
  typing(): Promise<void>;
}

export type Handler = (ctx: Context) => void | Promise<void>;

export interface CreateBotOptions extends ChaskyBotClientOptions {
  transport?: Transport | undefined;
  /** Attempts for one logical send before giving up. All reuse the same key. */
  sendAttempts?: number | undefined;
}

export interface Bot {
  command(name: string, handler: Handler): Bot;
  on(event: "text", handler: Handler): Bot;
  onError(listener: (error: unknown) => void): Bot;
  onFatal(listener: (error: unknown) => void): Bot;
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly client: ChaskyBotClient;
}

export function createBot(options: CreateBotOptions): Bot {
  const client = new ChaskyBotClient(options);

  const transport = options.transport ?? polling();
  const sendAttempts = options.sendAttempts ?? 4;
  const commands = new Map<string, Handler>();
  const textHandlers: Handler[] = [];
  const errorListeners: ((error: unknown) => void)[] = [];
  const fatalListeners: ((error: unknown) => void)[] = [];

  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;

  const emitError = (error: unknown): void => {
    for (const listener of errorListeners) listener(error);
  };
  const emitFatal = (error: unknown): void => {
    for (const listener of fatalListeners) listener(error);
  };

  async function dispatch(update: Update): Promise<void> {
    const message = update.message;
    if (!message) return;
    const ctx = makeContext(update, message);
    const command = parseCommand(message.text);
    const handler = command ? commands.get(command) : undefined;
    if (handler) {
      await handler(ctx);
      return;
    }
    for (const textHandler of textHandlers) await textHandler(ctx);
  }

  function makeContext(update: Update, message: BotMessage): Context {
    return {
      update,
      message,
      chatId: message.chat.id,
      client,
      reply: (text, replyOptions) =>
        sendWithRetry(
          client,
          // G9: the chat id goes back exactly as it arrived. Never parsed,
          // never coerced — a coerced id addresses the wrong chat silently.
          { chatId: message.chat.id, text, ...(replyOptions?.replyToMessageId ? { replyToMessageId: replyOptions.replyToMessageId } : {}) },
          { attempts: sendAttempts, signal: controller?.signal, onError: emitError },
        ),
      typing: async () => {
        await client.sendChatAction({ chatId: message.chat.id, action: "typing" }, controller?.signal);
      },
    };
  }

  const bot: Bot = {
    client,
    command(name, handler) {
      commands.set(name.replace(/^\//, ""), handler);
      return bot;
    },
    on(_event, handler) {
      textHandlers.push(handler);
      return bot;
    },
    onError(listener) {
      errorListeners.push(listener);
      return bot;
    },
    onFatal(listener) {
      fatalListeners.push(listener);
      return bot;
    },
    async start() {
      // G1: one in-flight poll per instance. Two overlapping polls on one bot
      // used to split the updates silently; the server now answers 409, but the
      // SDK should never be the one causing it.
      if (controller) throw new ChaskyUsageError("this bot is already started; call stop() before starting again");
      controller = new AbortController();
      const signal = controller.signal;
      loop = transport
        .run({ client, onUpdate: dispatch, onError: emitError, onFatal: emitFatal, signal })
        .catch((error: unknown) => {
          // A transport that throws out of its own loop is a bug in the SDK, not
          // in the author's bot. It must still reach them rather than vanish
          // into an unhandled rejection.
          emitFatal(error);
        });
    },
    async stop() {
      // G8: abort the in-flight long poll instead of waiting out the server's
      // deadline, which can be 30 seconds away.
      controller?.abort();
      controller = null;
      await loop?.catch(() => {});
      loop = null;
    },
  };

  return bot;
}

/**
 * G4: one key per logical message, the SAME key on every retry of THAT message.
 *
 * The key is generated once, outside the retry loop. Generating a fresh key per
 * attempt would turn a retry into a second message — the user sees the bot
 * answer twice — and reusing one key across different messages makes the server
 * discard the second SILENTLY, which is worse because it looks like it worked.
 */
async function sendWithRetry(
  client: ChaskyBotClient,
  params: { chatId: ChatID; text: string; replyToMessageId?: MessageID },
  options: { attempts: number; signal?: AbortSignal | undefined; onError: (error: unknown) => void },
): Promise<BotMessage> {
  const idempotencyKey = newIdempotencyKey();
  let lastError: unknown;
  for (let attempt = 1; attempt <= options.attempts; attempt++) {
    if (options.signal?.aborted) break;
    try {
      return await client.sendMessage(params, { idempotencyKey, ...(options.signal ? { signal: options.signal } : {}) });
    } catch (error) {
      lastError = error;
      if (classify(error, "call") !== "transient") throw error;
      if (attempt === options.attempts) break;
      options.onError(error);
      await sleep(Math.round(250 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5)), options.signal);
    }
  }
  throw lastError;
}

function newIdempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) {
    // Without randomness a unique key cannot be produced, and reusing one makes
    // the server drop the message without saying so. Not sending is the safer
    // failure: it is visible.
    throw new ChaskyUsageError("no secure randomness available to build an Idempotency-Key; refusing to send");
  }
  return uuid;
}

function parseCommand(text: string): string | undefined {
  const match = /^\/([A-Za-z0-9_]+)/.exec(text.trim());
  return match?.[1];
}
