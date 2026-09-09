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
}

export interface Chat {
  id: ChatID;
  type: string;
}

export interface BotMessage {
  messageId: MessageID;
  from: BotUser;
  chat: Chat;
  /** The wire carries seconds; this is a Date. */
  date: Date;
  text: string;
}

export interface Update {
  updateId: UpdateID;
  message?: BotMessage;
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

/** The `{ok, result}` / `{ok:false, error_code, description}` envelope. */
export type Envelope<T> =
  | { ok: true; result: T }
  | { ok: false; error_code?: number; description?: string };

/** Wire shapes, before mapping. Never exported from the package root. */
export interface WireBotMessage {
  message_id: MessageID;
  from?: { id: UserID; name: string };
  chat: { id: ChatID; type: string };
  date: number;
  text: string;
}

export interface WireUpdate {
  update_id: UpdateID;
  message?: WireBotMessage;
}
