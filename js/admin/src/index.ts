export { AdminClient } from "./client.js";
export { asPlatformSecret, ServerOnlyError, type PlatformSecret } from "./guard.js";
export type { CommandParams, AdminClientOptions, PageParams } from "./client.js";
export { AdminError, AdminTransportError, type AdminCode } from "./errors.js";
export type {
  BotView,
  Capability,
  CommandKind,
  CommandResult,
  DialogueEvent,
  DialogueStep,
  Draft,
  GrantView,
  OperationReceipt,
  OperationState,
  Page,
  SecretReveal,
} from "./types.js";
