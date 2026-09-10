import { AdminError, AdminTransportError, codeFor } from "./errors.js";
import { assertServerOnly, type PlatformSecret } from "./guard.js";
import type {
  BotView,
  Capability,
  CommandKind,
  CommandResult,
  DialogueEvent,
  GrantView,
  Page,
} from "./types.js";

export interface AdminClientOptions {
  baseUrl: string;
  /** A human session bearer token. Mutually exclusive with cookie auth. */
  bearerToken?: string | undefined;
  /**
   * The platform API secret, sent as X-Secret.
   *
   * Typed as PlatformSecret rather than string so that passing it takes an
   * explicit `asPlatformSecret(...)` — a line that reads wrong wherever it does
   * not belong.
   */
  apiSecret: PlatformSecret;
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

/**
 * The management surface: BotSmith, at `/bot-management`.
 *
 * Its credential is a human session plus the platform secret — nothing to do
 * with a bot token — which is why it has its own constructor. A single
 * constructor taking either credential would make it writable to send the
 * platform secret from a bot process (R-A in §6 of the contract).
 */
export class AdminClient {
  private readonly baseUrl: string;
  private readonly bearerToken: string | undefined;
  private readonly apiSecret: string;
  private readonly doFetch: typeof globalThis.fetch;
  private readonly newOperationId: () => string;

  constructor(options: AdminClientOptions) {
    // Before anything else: this must not be running in a browser.
    assertServerOnly();
    if (!options.apiSecret) throw new Error("an API secret is required");
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.bearerToken = options.bearerToken;
    this.apiSecret = options.apiSecret;
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

    const headers: Record<string, string> = { "X-Secret": this.apiSecret };
    // Bearer OR cookie, never both: the server rejects anything but exactly one
    // Authorization header with exactly two fields, and falls back to the
    // cookie only when the header is absent.
    if (this.bearerToken) headers["Authorization"] = `Bearer ${this.bearerToken}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    let response: Response;
    try {
      response = await this.doFetch(`${this.baseUrl}/bot-management${path}${suffix}`, {
        method,
        headers,
        // Cookie auth needs the browser to attach it.
        credentials: "include",
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
