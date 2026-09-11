import { AdminError, AdminTransportError, codeFor } from "./errors.js";
import { createBot, type CreateBotParams, type CreateBotResult } from "./facade.js";
import { assertServerOnly, type DeveloperKey } from "./guard.js";
import type {
  BotView,
  Capability,
  CommandKind,
  CommandResult,
  DeveloperKeyView,
  DialogueEvent,
  GrantView,
  Page,
} from "./types.js";

export interface AdminClientOptions {
  baseUrl: string;
  /**
   * EXACTLY ONE of developerKey or bearerToken. Not zero, not both.
   *
   * The server rejects a request carrying two credentials instead of picking
   * one, because picking by precedence hides a misconfiguration. This mirrors
   * that rule at construction time, so the mistake surfaces where it was made
   * rather than as an anonymous 401 on the first call.
   */
  developerKey?: DeveloperKey | undefined;
  /** A human session bearer token — how the portal's own backend calls this. */
  bearerToken?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
  /** Supplies operationID values; override in tests for determinism. */
  newOperationId?: (() => string) | undefined;
}

export interface CommandParams {
  command: CommandKind;
  expectedRevision: number;
  value?: string | undefined;
  botID?: string | undefined;
  expectedCredentialVersion?: number | undefined;
  /** Reused verbatim on a retry, exactly like the runtime's Idempotency-Key. */
  operationID?: string | undefined;
}

export interface PageParams {
  cursor?: string | undefined;
  limit?: number | undefined;
}

/** The header a developer key travels in. Never Authorization: see below. */
const DEVELOPER_KEY_HEADER = "X-Chasky-Dev-Secret";

/**
 * The management surface: BotSmith, at `/bot-management`.
 *
 * Its credential is a developer key or a human session — nothing to do with a
 * bot token — which is why it has its own constructor. A single constructor
 * taking either credential would make it writable to send an administration
 * credential from a bot process (R-A in §6 of the contract).
 */
export class AdminClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly developerKey: string | undefined;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly newOperationId: () => string;

  constructor(options: AdminClientOptions) {
    // Before anything else: this must not be running in a browser.
    assertServerOnly();
    if (options.developerKey && options.bearerToken) {
      throw new Error(
        "pass a developerKey or a bearerToken, not both: the server rejects a " +
          "request carrying two credentials rather than choosing between them",
      );
    }
    if (!options.developerKey && !options.bearerToken) {
      throw new Error("a developerKey or a bearerToken is required");
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.bearerToken = options.bearerToken;
    this.developerKey = options.developerKey;
    this.doFetch = options.fetch ?? globalThis.fetch;
    this.newOperationId = options.newOperationId ?? (() => crypto.randomUUID());
  }

  capability(signal?: AbortSignal): Promise<Capability> {
    return this.request<Capability>("GET", "/capability", undefined, undefined, signal);
  }

  bots(params: PageParams = {}, signal?: AbortSignal): Promise<Page<BotView>> {
    return this.request<Page<BotView>>("GET", "/bots", undefined, params, signal);
  }

  bot(id: string, signal?: AbortSignal): Promise<BotView> {
    return this.request<BotView>("GET", `/bots/${encodeURIComponent(id)}`, undefined, undefined, signal);
  }

  dialogue(params: PageParams = {}, signal?: AbortSignal): Promise<Page<DialogueEvent> & { current: DialogueEvent }> {
    return this.request("GET", "/dialogue", undefined, params, signal);
  }

  /**
   * The caller's developer keys, revoked ones included. Each carries a
   * publishable preview, never the hash or the value: the value exists once,
   * in the confirm that issued it.
   */
  developerKeys(signal?: AbortSignal): Promise<DeveloperKeyView[]> {
    return this.request<DeveloperKeyView[]>("GET", "/developer-keys", undefined, undefined, signal);
  }

  command(params: CommandParams, signal?: AbortSignal): Promise<CommandResult> {
    // Built field by field, and ONLY when defined. The server's decoder rejects
    // an unknown field, a duplicate, and a null even where the field is
    // optional — so "omit" is not a style preference here, it is the contract.
    const body: Record<string, unknown> = {
      operationID: params.operationID ?? this.newOperationId(),
      expectedRevision: params.expectedRevision,
      command: params.command,
    };
    if (params.value !== undefined) body["value"] = params.value;
    if (params.botID !== undefined) body["botID"] = params.botID;
    if (params.expectedCredentialVersion !== undefined) {
      body["expectedCredentialVersion"] = params.expectedCredentialVersion;
    }
    return this.request<CommandResult>("POST", "/commands", body, undefined, signal);
  }

  /**
   * Create a bot in one call, driving the four-step dialogue underneath.
   *
   * See facade.ts for what this can and cannot hide.
   */
  createBot(params: CreateBotParams): Promise<CreateBotResult> {
    return createBot(this, params);
  }

  grant(
    targetId: string,
    params: { enabled: boolean; expectedRevision: number; operationID?: string },
    signal?: AbortSignal,
  ): Promise<GrantView> {
    const body = {
      operationID: params.operationID ?? this.newOperationId(),
      expectedRevision: params.expectedRevision,
      enabled: params.enabled,
    };
    return this.request<GrantView>(
      "PUT",
      `/administrators/${encodeURIComponent(targetId)}`,
      body,
      undefined,
      signal,
    );
  }

  private async request<T>(
    method: string,
    path: string,
    body: unknown,
    page: PageParams | undefined,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const query = new URLSearchParams();
    // Only cursor and limit exist; the server rejects any other key outright.
    if (page?.cursor !== undefined) query.set("cursor", page.cursor);
    if (page?.limit !== undefined) query.set("limit", String(page.limit));
    const suffix = query.size > 0 ? `?${query}` : "";

    // ONE credential leaves this client, never two. The server treats a key
    // next to a session as a misconfiguration and answers 401 instead of
    // choosing, so sending both would turn a working key into a mystery.
    const headers: Record<string, string> = {};
    if (this.developerKey) headers[DEVELOPER_KEY_HEADER] = this.developerKey;
    else if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/bot-management${path}${suffix}`, {
        method,
        headers,
        // Cookies travel only on the session path. With a key they would be a
        // SECOND credential on the same request, which the server rejects — so
        // a stray cookie would break a perfectly good key.
        credentials: this.developerKey ? "omit" : "include",
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        ...(signal ? { signal } : {}),
      } as RequestInit);
    } catch (error) {
      throw new AdminTransportError(`${method} ${path} could not reach the server`, error);
    }

    let envelope: { ok?: boolean; data?: T; error?: { code?: string } };
    try {
      envelope = (await response.json()) as typeof envelope;
    } catch (error) {
      throw new AdminTransportError(
        `${method} ${path} returned a body that is not JSON (HTTP ${response.status})`,
        error,
      );
    }

    if (!envelope.ok) {
      throw new AdminError(codeFor(envelope.error?.code, response.status), response.status, `${method} ${path}`);
    }
    return envelope.data as T;
  }
}
