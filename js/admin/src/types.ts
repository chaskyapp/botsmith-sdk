/** Management view types, mirroring the server's allowlisted projections. */

export interface BotView {
  id: string;
  name: string;
  username: string;
  description: string;
  state: string;
  credentialState: string;
  credentialVersion: number;
  metadataVersion: number;
}

export interface Capability {
  enabled: boolean;
  canManageAdministrators: boolean;
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

export interface CommandResult {
  event: DialogueEvent;
  secret?: SecretReveal;
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
  | "confirm";
