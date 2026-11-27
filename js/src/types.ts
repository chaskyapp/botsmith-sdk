/**
 * Domain types. See §7.1 of ../../docs/00-spec.md.
 *
 * Every identifier is a `string` and the SDK never converts one (G9). The one
 * numeric exception is UpdateID — see §9 of the contract before "fixing" it.
 */

export type ChatID = string;
export type UserID = string;
export type MessageID = string;
export type UpdateID = number;

export interface BotUser {
  id: UserID;
  name: string;
  /** Sent in groups. Absent in a 1:1, where the sender is always a person. */
  isBot?: boolean;
}

export interface Chat {
  id: ChatID;
  /**
   * `private` or `group` today. Typed as a string on purpose: a value this
   * version does not know is passed through, never rejected (G10).
   */
  type: string;
  /** The group's name. Only groups have one. */
  title?: string;
}

/** A person the message mentions. Bots are never listed here. */
export interface Mention {
  userId: UserID;
  name: string;
}

/** The message being answered, as the server summarises it. */
export interface ReplyTo {
  messageId: MessageID;
  from: BotUser;
  /** Truncated by the server to 500 characters. */
  text: string;
}

export interface BotMessage {
  messageId: MessageID;
  from: BotUser;
  chat: Chat;
  /** The wire carries seconds; this is a Date. */
  date: Date;
  text: string;
  /** The people mentioned, as the server sent them (G12). Absent when none. */
  mentions?: Mention[];
  /** True only when the message mentions THIS bot. Absent otherwise. */
  mentioned?: boolean;
  replyToMessage?: ReplyTo;
}

/** `member` or `left`; the modes only travel while the bot is a member. */
export interface ChatMemberState {
  status: string;
  /** `all` or `mentions`. */
  readMode?: string;
  /** `full` or `since_join`. */
  historyMode?: string;
}

/** The bot was added to a group, had its modes changed, or left it. */
export interface ChatMemberUpdated {
  chat: Chat;
  /** Who made the change. */
  from: BotUser;
  date: Date;
  oldState: ChatMemberState;
  newState: ChatMemberState;
}

export interface Update {
  updateId: UpdateID;
  message?: BotMessage;
  myChatMember?: ChatMemberUpdated;
  /**
   * The update exactly as the server sent it. For a kind this version has no
   * field for, this is the only way to read it — and it still arrives (G10).
   */
  raw: Record<string, unknown>;
}

export interface BotIdentity {
  id: UserID;
  isBot: true;
  username: string;
  /**
   * Mapped from the server's `first_name`. That field is Telegram-shaped while
   * the rest of the contract is Chasky-shaped (`from.name`); the SDK absorbs the
   * asymmetry rather than propagating it. Server request S2 in §13.
   */
  displayName: string;
}

export type ChatAction = "typing";

/**
 * What `getWebhookInfo` reports.
 *
 * An empty `state` means the bot has no destination registered and is still
 * polling; `active` and `suspended` are the webhook states. `hasSecretToken`
 * answers "is one configured", never "which one" — the server does not reveal
 * it and neither does this.
 */
export interface WebhookInfo {
  url: string;
  hasSecretToken: boolean;
  pendingUpdateCount: number;
  /**
   * The LAST RUN of failures, not all time: a successful delivery clears them.
   * An error from three days ago beside a working webhook explains nothing.
   */
  lastErrorDate?: Date;
  lastErrorMessage?: string;
  /** Empty means polling. */
  state?: "active" | "suspended";
}

export interface WireWebhookInfo {
  url?: string;
  has_secret_token?: boolean;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
  state?: string;
}

/** The `{ok, result}` / `{ok:false, error_code, description}` envelope. */
export type Envelope<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string; parameters?: { retry_after?: number } };

/** Wire shapes, before mapping. Never exported from the package root. */
export interface WireUser {
  id: UserID;
  name: string;
  is_bot?: boolean;
}

export interface WireChat {
  id: ChatID;
  type: string;
  title?: string;
}

export interface WireBotMessage {
  message_id: MessageID;
  from?: WireUser;
  chat: WireChat;
  date: number;
  text: string;
  mentions?: { user_id: UserID; name?: string }[];
  mentioned?: boolean;
  reply_to_message?: { message_id: MessageID; from?: WireUser; text?: string };
}

export interface WireMemberState {
  status: string;
  read_mode?: string;
  history_mode?: string;
}

export interface WireUpdate {
  update_id: UpdateID;
  message?: WireBotMessage;
  my_chat_member?: {
    chat: WireChat;
    from?: WireUser;
    date: number;
    old_state?: WireMemberState;
    new_state?: WireMemberState;
  };
}
