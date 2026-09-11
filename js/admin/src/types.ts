/**
 * View types for the server's management surface, mirroring its allowlisted
 * projections. The package is called `admin` after its audience; these names
 * follow the server's own, which is `/bot-management`.
 */

export interface BotView {
  id: string;
  name: string;
  username: string;
  description: string;
  state: string;
  /** What the dialogue compare-and-sets when publishing, as `state` is for archiving. */
  visibility: string;
  /** The destination. The SECRET never appears here or in any view. */
  webhookUrl: string;
  webhookState: string;
  credentialState: string;
  credentialVersion: number;
  metadataVersion: number;
}

export interface Capability {
  enabled: boolean;
  canManageAdministrators: boolean;
  /**
   * Published so a client can warn BEFORE the user spends four steps typing a
   * name and username only to be refused at confirm. The cap is still the
   * backend's: this announces it, it does not decide it.
   */
  maxBots: number;
  /** Announces the gate so a client does not offer a button that always fails. */
  webhookEnabled: boolean;
  /** Announces whether the server has developer keys wired, for the same reason. */
  developerKeysEnabled: boolean;
}

export interface Page<T> {
  items: T[];
  nextCursor?: string;
  hasMore: boolean;
}

export type DialogueStep =
  | "menu"
  | "new_name"
  | "new_username"
  | "confirm_create"
  | "select_bot"
  | "bot_menu"
  | "edit_name"
  | "edit_description"
  | "webhook_url"
  | "keys"
  | "key_label"
  | "key_preview"
  | "confirm_change";

export type OperationState = "pending" | "completed" | "rejected";

export interface Draft {
  name?: string;
  username?: string;
  description?: string;
  botID?: string;
  action?: string;
  expectedMetadataVersion?: number;
  expectedCredentialVersion?: number;
  keyLabel?: string;
  keyPreview?: string;
}

export interface OperationReceipt {
  operationID: string;
  botID?: string;
  credentialVersion?: number;
  state: OperationState;
}

export interface DialogueEvent {
  revision: number;
  step: DialogueStep;
  draft: Draft;
  receipt: OperationReceipt;
  /**
   * A CODE, not rendered text. The server is explicit that codes are the
   * durable transcript format and that user-facing text must be rendered from
   * them, so this SDK does not promise a readable message.
   */
  messageCode: string;
  createdAt: string;
}

/**
 * The one response that carries a live token. The server marks it
 * response-only — its own String() prints "[credential redacted]" — so this
 * SDK returns it to the caller and retains it nowhere.
 */
export interface SecretReveal {
  botID: string;
  token: string;
  version: number;
}

/**
 * A live developer key. It exists only in the response to the confirm that
 * issued it — the server keeps just its hash — so it is returned to the caller
 * once and retained nowhere else.
 */
export interface DeveloperKeyReveal {
  value: string;
  ownerID: string;
  createdAt: string;
}

/**
 * What a listing shows about a key: its publishable preview (sk_ + 6 hex,
 * enough to recognise it and to revoke it), never the hash or the value. A
 * revoked key is listed on purpose, as the record that it existed.
 */
export interface DeveloperKeyView {
  preview: string;
  label?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface CommandResult {
  event: DialogueEvent;
  secret?: SecretReveal;
  /** Only on the confirm that issued a key. The one copy that will ever exist. */
  developerKey?: DeveloperKeyReveal;
  recoveryRequired?: boolean;
}

export interface GrantView {
  targetID: string;
  revision: number;
  enabled: boolean;
}

/** The dialogue's command vocabulary, closed as the server declares it. */
export type CommandKind =
  | "/newbot"
  | "/mybots"
  | "/help"
  | "/cancel"
  | "value"
  | "select"
  | "name"
  | "description"
  | "issue"
  | "rotate"
  | "revoke"
  | "archive"
  | "unarchive"
  | "publish"
  | "unpublish"
  | "webhook"
  | "unwebhook"
  | "/keys"
  | "newkey"
  | "revokekey"
  | "confirm";
