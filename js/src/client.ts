import { ChaskyApiError, ChaskyTransportError, ChaskyUsageError } from "./errors.js";
import { redactError } from "./redact.js";
import type {
  BotIdentity,
  BotMessage,
  BotUser,
  Chat,
  ChatMemberState,
  ChatAction,
  ChatID,
  Envelope,
  MessageID,
  Update,
  WebhookInfo,
  WireBotMessage,
  WireChat,
  WireMemberState,
  WireUpdate,
  WireUser,
  WireWebhookInfo,
} from "./types.js";

/**
 * Server maximums, hardcoded because the server does not publish them yet
 * (request S3 in §13). When it does, these become a fallback.
 */
export const MAX_LIMIT = 100;
export const MAX_TIMEOUT_SECONDS = 30;

export const DEFAULT_BASE_URL = "https://api.chasky.io/api/v1";

export interface ChaskyBotClientOptions {
  token: string;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  onWarning?: ((message: string) => void) | undefined;
  /** Opt out of the plaintext-transport warning (D8). */
  allowInsecureTransport?: boolean | undefined;
}

export interface GetUpdatesParams {
  offset?: number | undefined;
  limit?: number | undefined;
  timeoutSeconds?: number | undefined;
}

export interface SendMessageParams {
  chatId: ChatID;
  text: string;
  replyToMessageId?: MessageID | undefined;
}

/** A 1:1 wrapper over the four methods. No loop, no state beyond configuration. */
export class ChaskyBotClient {
  private readonly token: string;
  private readonly baseUrl: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly warn: (message: string) => void;

  constructor(options: ChaskyBotClientOptions) {
    if (!options.token) throw new ChaskyUsageError("a bot token is required");
    this.token = options.token;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.warn = options.onWarning ?? (() => {});

    // D8: warn ONCE, at construction. A warning per poll is noise that ends up
    // filtered out of a grep, which is the same as no warning at all.
    if (!options.allowInsecureTransport && isInsecure(this.baseUrl)) {
      this.warn(
        `baseUrl uses plaintext http:// to a non-loopback host. The bot token travels ` +
          `in the URL PATH, so every proxy on the way writes it down. Use https://, or ` +
          `pass allowInsecureTransport: true to accept this.`,
      );
    }
  }

  async getMe(signal?: AbortSignal): Promise<BotIdentity> {
    const raw = await this.call<{ id: string; username: string; first_name?: string; display_name?: string }>(
      "getMe",
      {},
      { signal },
    );
    return {
      id: raw.id,
      isBot: true,
      username: raw.username,
      // Prefer display_name if the server ever adds it (S2), fall back to today's.
      displayName: raw.display_name ?? raw.first_name ?? "",
    };
  }

  async getUpdates(params: GetUpdatesParams = {}, signal?: AbortSignal): Promise<Update[]> {
    const body = {
      offset: params.offset ?? 0,
      limit: this.clampLimit(params.limit),
      timeout: this.clampTimeout(params.timeoutSeconds),
    };
    const raw = await this.call<WireUpdate[]>("getUpdates", body, { signal });
    // A missing or malformed result is an empty batch, never a crash: the poll
    // loop must survive a server that answers something unexpected.
    return Array.isArray(raw) ? raw.map(toUpdate) : [];
  }

  async sendMessage(
    params: SendMessageParams,
    options: { idempotencyKey?: string | undefined; signal?: AbortSignal | undefined } = {},
  ): Promise<BotMessage> {
    if (!params.text) throw new ChaskyUsageError("sendMessage requires a non-empty text");
    const body: Record<string, unknown> = { chat_id: params.chatId, text: params.text };
    if (params.replyToMessageId !== undefined) body["reply_to_message_id"] = params.replyToMessageId;

    const headers: Record<string, string> = {};
    if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey;

    const raw = await this.call<WireBotMessage>("sendMessage", body, { headers, signal: options.signal });
    return toBotMessage(raw);
  }

  /**
   * Reports the bot's webhook state. Empty `state` means it is still polling.
   *
   * The one method with no conformance case until 2026-09-10, because the
   * contract did not know the surface existed.
   */
  async getWebhookInfo(signal?: AbortSignal): Promise<WebhookInfo> {
    const raw = await this.call<WireWebhookInfo>("getWebhookInfo", {}, { signal });
    const info: WebhookInfo = {
      url: raw.url ?? "",
      hasSecretToken: raw.has_secret_token ?? false,
      pendingUpdateCount: raw.pending_update_count ?? 0,
    };
    if (raw.last_error_date) info.lastErrorDate = new Date(raw.last_error_date * 1000);
    if (raw.last_error_message) info.lastErrorMessage = raw.last_error_message;
    if (raw.state) info.state = raw.state as "active" | "suspended";
    return info;
  }

  async sendChatAction(
    params: { chatId: ChatID; action: ChatAction },
    signal?: AbortSignal,
  ): Promise<true> {
    await this.call<true>("sendChatAction", { chat_id: params.chatId, action: params.action }, { signal });
    return true;
  }

  private clampLimit(limit: number | undefined): number {
    if (limit === undefined) return MAX_LIMIT;
    if (!Number.isInteger(limit) || limit < 1) {
      // The server answers 400 to these. Rejecting locally, with the reason,
      // beats spending a request to be told the same thing less clearly.
      throw new ChaskyUsageError(`limit must be an integer of at least 1, got ${limit}`);
    }
    if (limit > MAX_LIMIT) {
      this.warn(`limit ${limit} clamped to the server maximum of ${MAX_LIMIT}`);
      return MAX_LIMIT;
    }
    return limit;
  }

  private clampTimeout(seconds: number | undefined): number {
    if (seconds === undefined) return 0;
    if (!Number.isInteger(seconds) || seconds < 0) {
      throw new ChaskyUsageError(`timeoutSeconds must be a non-negative integer, got ${seconds}`);
    }
    if (seconds > MAX_TIMEOUT_SECONDS) {
      this.warn(`timeoutSeconds ${seconds} clamped to the server maximum of ${MAX_TIMEOUT_SECONDS}`);
      return MAX_TIMEOUT_SECONDS;
    }
    return seconds;
  }

  private async call<T>(
    method: string,
    body: unknown,
    options: { headers?: Record<string, string>; signal?: AbortSignal | undefined },
  ): Promise<T> {
    const url = `${this.baseUrl}/bot${this.token}/${method}`;
    let response: Response;
    try {
      response = await this.doFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...options.headers },
        body: JSON.stringify(body),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } catch (error) {
      // The URL is in here. Redact before it can reach a log.
      throw new ChaskyTransportError(`${method} could not reach the server: ${describe(error)}`, {
        cause: redactError(error, this.token),
        token: this.token,
      });
    }

    let envelope: Envelope<T>;
    try {
      envelope = (await response.json()) as Envelope<T>;
    } catch (error) {
      throw new ChaskyTransportError(`${method} returned a body that is not JSON (HTTP ${response.status})`, {
        cause: redactError(error, this.token),
        token: this.token,
      });
    }

    if (!envelope.ok) {
      throw new ChaskyApiError(
        envelope.error_code ?? response.status,
        envelope.description ?? "UNKNOWN",
        method,
        envelope.parameters?.retry_after,
      );
    }
    return envelope.result;
  }
}

function toUser(raw: WireUser | undefined): BotUser {
  const user: BotUser = { id: raw?.id ?? "", name: raw?.name ?? "" };
  if (typeof raw?.is_bot === "boolean") user.isBot = raw.is_bot;
  return user;
}

function toChat(raw: WireChat): Chat {
  return raw.title === undefined ? { id: raw.id, type: raw.type } : { id: raw.id, type: raw.type, title: raw.title };
}

function toBotMessage(raw: WireBotMessage): BotMessage {
  const message: BotMessage = {
    messageId: raw.message_id,
    from: toUser(raw.from),
    chat: toChat(raw.chat),
    date: new Date((raw.date ?? 0) * 1000),
    text: raw.text ?? "",
  };
  const reply = raw.reply_to_message;
  if (reply) message.replyToMessage = { messageId: reply.message_id, from: toUser(reply.from), text: reply.text ?? "" };
  return message;
}

function toMemberState(raw: WireMemberState | undefined): ChatMemberState {
  const state: ChatMemberState = { status: raw?.status ?? "" };
  if (raw?.read_mode) state.readMode = raw.read_mode;
  if (raw?.history_mode) state.historyMode = raw.history_mode;
  return state;
}

/** G10: a kind without a field here still becomes an Update, carrying `raw`. */
function toUpdate(raw: WireUpdate): Update {
  const update: Update = { updateId: raw.update_id, raw: raw as unknown as Record<string, unknown> };
  if (raw.message) update.message = toBotMessage(raw.message);
  const member = raw.my_chat_member;
  if (member) {
    update.myChatMember = {
      chat: toChat(member.chat),
      from: toUser(member.from),
      date: new Date((member.date ?? 0) * 1000),
      oldState: toMemberState(member.old_state),
      newState: toMemberState(member.new_state),
    };
  }
  return update;
}

/** Loopback only, deliberately excluding *.local — mDNS can be a real machine. */
function isInsecure(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  return !(
    host === "localhost" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".localhost") ||
    /^127\./.test(host)
  );
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
