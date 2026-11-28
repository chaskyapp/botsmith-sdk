import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Exchange, Json, ObservedRequest } from "./types.js";

/**
 * How long the fake holds an idle steady-state poll. A real long poll blocks for
 * seconds; answering instantly would let a healthy bot hammer the fake hundreds
 * of times per case and bury a single defect under its own repetition.
 */
const STEADY_STATE_POLL_MS = 25;

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
  /** Kept after stop(): a response still in flight may need it for {baseUrl}. */
  private listeningAt = "";

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
    this.listeningAt = this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req);
    const contentType = req.headers["content-type"] ?? "";
    const receivedAt = Date.now();
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === "string") headers[k] = v;
      else if (Array.isArray(v)) headers[k] = v.join(", ");
    }
    const record: ObservedRequest = {
      method: req.method ?? "",
      path: req.url ?? "",
      headers,
      body: contentType.startsWith("multipart/form-data") ? parseMultipart(raw, contentType) : parseJson(raw.toString("utf8")),
      receivedAt,
    };

    const last = this.exchanges[this.exchanges.length - 1];
    const steadyState = last?.repeat === true && this.index >= this.exchanges.length;
    const exchange = steadyState ? last : this.exchanges[this.index];
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
    if (!steadyState) this.index++;
    const { respond } = exchange;

    const delay = respond.delayMs ?? (steadyState ? STEADY_STATE_POLL_MS : 0);
    if (delay) await sleep(delay);

    if (respond.transportError !== undefined) {
      // Kill the connection rather than answer. The client library is what turns
      // this into an error message carrying the full URL — which is exactly the
      // G5 scenario the SDK has to redact.
      req.socket.destroy();
      return;
    }

    if (respond.rawBody !== undefined) {
      res.writeHead(respond.status ?? 200, { "content-type": "application/octet-stream" });
      res.end(respond.rawBody);
      return;
    }
    res.writeHead(respond.status ?? 200, { "content-type": "application/json" });
    // {baseUrl} lets a case hand the SDK a URL back to this fake (G14).
    res.end(JSON.stringify(respond.body ?? null).replaceAll("{baseUrl}", this.listeningAt));
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * A multipart body as an object: text fields as strings, file parts as
 * `{fileName, size}` (SCHEMA.md). Anything malformed comes back as the raw
 * text, so the case fails on the field it expected rather than on a crash.
 */
function parseMultipart(raw: Buffer, contentType: string): Json {
  const boundary = /boundary="?([^";]+)"?/.exec(contentType)?.[1];
  if (!boundary) return raw.toString("latin1");
  const delimiter = Buffer.from(`--${boundary}`);
  const out: Record<string, Json> = {};
  let at = raw.indexOf(delimiter);
  while (at >= 0) {
    const start = at + delimiter.length;
    if (raw.subarray(start, start + 2).toString() === "--") return out;
    const next = raw.indexOf(delimiter, start);
    if (next < 0) break;
    const part = raw.subarray(start + 2, next - 2); // drop the CRLFs around it
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) break;
    const head = part.subarray(0, split).toString("utf8");
    const content = part.subarray(split + 4);
    const name = /[;\s]name="((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
    const fileName = /filename="((?:[^"\\]|\\.)*)"/.exec(head)?.[1];
    if (name === undefined) break;
    out[name] =
      fileName === undefined
        ? content.toString("utf8")
        : { fileName: fileName.replace(/\\(.)/g, "$1"), size: content.length };
    at = next;
  }
  return raw.toString("latin1");
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
