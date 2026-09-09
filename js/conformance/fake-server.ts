import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Exchange, Json, ObservedRequest } from "./types.js";

/**
 * An HTTP server driven by a case's exchange list.
 *
 * The exchange list is exhaustive by contract: anything the SDK sends beyond the
 * last exchange is recorded as an "extra" and fails the case. That is what lets
 * g7-409-stops-and-sends-nothing-more assert "not one further request" without
 * any special syntax.
 */
export class FakeServer {
  private server: Server | null = null;
  private index = 0;

  readonly observed: ObservedRequest[] = [];
  readonly extras: ObservedRequest[] = [];

  constructor(private readonly exchanges: Exchange[]) {}

  get baseUrl(): string {
    const address = this.server?.address();
    if (!address || typeof address === "string") throw new Error("fake server is not listening");
    return `http://127.0.0.1:${address.port}`;
  }

  /** True once every declared exchange has been consumed. */
  get exhausted(): boolean {
    return this.index >= this.exchanges.length;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    const record: ObservedRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers,
      body: parseJson(raw),
    };

    const exchange = this.exchanges[this.index];
    if (!exchange) {
      // Beyond the declared list. Recorded, then answered so the SDK does not
      // hang waiting: the case fails on the record, not on a timeout, because a
      // timeout would hide WHICH request was unexpected.
      this.extras.push(record);
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error_code: 500, description: "UNEXPECTED_REQUEST" }));
      return;
    }

    this.observed.push(record);
    this.index++;
    const { respond } = exchange;

    if (respond.delayMs) await sleep(respond.delayMs);

    if (respond.transportError !== undefined) {
      // Kill the connection rather than answer. The client library is what turns
      // this into an error message carrying the full URL — which is exactly the
      // G5 scenario the SDK has to redact.
      req.socket.destroy();
      return;
    }

    res.writeHead(respond.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(respond.body ?? null));
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseJson(raw: string): Json {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Json;
  } catch {
    return raw;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
