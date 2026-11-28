import { ChaskyBotClient, type ChaskyBotClientOptions } from "./client.js";
import { ChaskyUsageError, classify, retryDelayMs } from "./errors.js";
import { polling, sleep, type Transport } from "./polling.js";
import type { BotMessage, ChatID, MessageID, Update, UserID } from "./types.js";

export interface Context {
  readonly update: Update;
  readonly message: BotMessage;
  readonly chatId: ChatID;
  readonly client: ChaskyBotClient;
  /** sendMessage to this update's chat, with a managed Idempotency-Key. */
  reply(text: string, options?: ReplyOptions): Promise<BotMessage>;
  /** Explicit on purpose — the runtime never sends a chat action by itself. */
  typing(): Promise<void>;
}

export interface ReplyOptions {
  replyToMessageId?: MessageID;
  /** `{ "<name as it appears in text>": "<user id>" }`, as in sendMessage. */
  mentions?: Record<string, UserID>;
}

export type Handler = (ctx: Context) => void | Promise<void>;

/** Sees every update, including `myChatMember` and kinds this version has no field for. */
export type UpdateHandler = (update: Update, client: ChaskyBotClient) => void | Promise<void>;

export interface CreateBotOptions extends ChaskyBotClientOptions {
  transport?: Transport | undefined;
  /** Attempts for one logical send before giving up. All reuse the same key. */
  sendAttempts?: number | undefined;
}

export interface Bot {
  command(name: string, handler: Handler): Bot;
  on(event: "text", handler: Handler): Bot;
  /**
   * Runs for a message that carries attachments, instead of the text and
   * command handlers: its `text` is empty and what was written is `caption`
   * (G14).
   */
  on(event: "attachment", handler: Handler): Bot;
  /** Runs before the text and command handlers, for every update (G10). */
  on(event: "update", handler: UpdateHandler): Bot;
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
  const attachmentHandlers: Handler[] = [];
  const updateHandlers: UpdateHandler[] = [];
  const errorListeners: ((error: unknown) => void)[] = [];
  const fatalListeners: ((error: unknown) => void)[] = [];

  let controller: AbortController | null = null;
  let loop: Promise<void> | null = null;
  /** Learned from getMe the first time a suffixed command needs it (G13). */
  let username: string | undefined;

  const emitError = (error: unknown): void => {
    for (const listener of errorListeners) listener(error);
  };
  const emitFatal = (error: unknown): void => {
    for (const listener of fatalListeners) listener(error);
  };

  async function dispatch(update: Update): Promise<void> {
    for (const updateHandler of updateHandlers) await updateHandler(update, client);
    const message = update.message;
    if (!message) return;
    const ctx = makeContext(update, message);
    if (message.attachments?.length) {
      // Never the text handler: it would see "" and answer a file as if it
      // were an empty message (G14).
      for (const attachmentHandler of attachmentHandlers) await attachmentHandler(ctx);
      return;
    }
    const handler = await commandHandler(message.text);
    if (handler) {
      await handler(ctx);
      return;
    }
    for (const textHandler of textHandlers) await textHandler(ctx);
  }

  /** The handler for a command addressed to this bot, if any (G13). */
  async function commandHandler(text: string): Promise<Handler | undefined> {
    const { name, target } = parseCommand(text);
    const handler = name ? commands.get(name) : undefined;
    if (!handler || target === undefined) return handler;
    // Asked once, and only when a suffix makes it matter. A failure is not
    // cached: it surfaces like any handler failure and the next suffixed
    // command asks again.
    username ??= (await client.getMe(controller?.signal)).username;
    return sameUsername(target, username) ? handler : undefined;
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
          {
            chatId: message.chat.id,
            text,
            ...(replyOptions?.replyToMessageId ? { replyToMessageId: replyOptions.replyToMessageId } : {}),
            ...(replyOptions?.mentions ? { mentions: replyOptions.mentions } : {}),
          },
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
    on(event: "text" | "attachment" | "update", handler: Handler | UpdateHandler) {
      if (event === "update") updateHandlers.push(handler as UpdateHandler);
      else if (event === "attachment") attachmentHandlers.push(handler as Handler);
      else textHandlers.push(handler as Handler);
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
  params: { chatId: ChatID; text: string; replyToMessageId?: MessageID; mentions?: Record<string, UserID> },
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
      // A 429 says how long to wait (G11); the key above stays the same.
      const backoff = Math.round(250 * 2 ** (attempt - 1) * (0.5 + Math.random() * 0.5));
      await sleep(retryDelayMs(error, backoff), options.signal);
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

/**
 * Splits `/name@target args` into its name and target, by the server's rule
 * (isCommandFor): the command word runs from the slash to the first whitespace,
 * with no trimming before the slash. `target` is undefined when there is no
 * `@`, and `""` for a bare `/name@`, which addresses no bot. An empty `name`
 * means the text is not a command at all.
 */
function parseCommand(text: string): { name: string; target: string | undefined } {
  const match = /^\/([^ \t\r\n]*)/.exec(text);
  if (!match) return { name: "", target: undefined };
  const word = match[1]!;
  const at = word.indexOf("@");
  return at < 0 ? { name: word, target: undefined } : { name: word.slice(0, at), target: word.slice(at + 1) };
}

/** Case-insensitive, with a leading `@` ignored on the bot's side. */
function sameUsername(target: string, username: string): boolean {
  return target !== "" && target.toLowerCase() === username.replace(/^@/, "").toLowerCase();
}
