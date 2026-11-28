import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { basename } from "node:path";

/**
 * The server's limit per file (decision A17 of its SDD): 100 MB. A larger file
 * is refused locally, before any request (G15).
 */
export const MAX_DOCUMENT_BYTES = 100 * 1024 * 1024;

/**
 * A file to send with `sendDocument`.
 *
 * `open` is called once per attempt and must return the file from its start
 * every time: a retry sends the whole file again (G15). `size` is read before
 * the request, so the limit is enforced without sending anything, and the
 * body goes out with a `Content-Length` rather than chunked.
 */
export interface InputFile {
  /** Shown to people as the file's name. The type is detected from the bytes. */
  fileName: string;
  size(): Promise<number>;
  open(): AsyncIterable<Uint8Array>;
}

/** A file on disk, streamed from it on every attempt; never read whole. */
export function fileFromPath(path: string, fileName: string = basename(path)): InputFile {
  return {
    fileName,
    size: async () => (await stat(path)).size,
    open: () => createReadStream(path),
  };
}

/** Bytes already in memory. */
export function fileFromBytes(data: Uint8Array, fileName: string): InputFile {
  return {
    fileName,
    size: async () => data.byteLength,
    open: async function* () {
      yield data;
    },
  };
}

/**
 * A multipart/form-data body, built by hand so its length is known before the
 * file is read: the text fields and the file's part header are small and go
 * first, the file streams after them, and the closing boundary ends it.
 */
export function multipartBody(
  fields: Record<string, string>,
  file: InputFile,
  size: number,
): { contentType: string; length: number; body: ReadableStream<Uint8Array> } {
  const boundary = `chasky-botsmith-${crypto.randomUUID()}`;
  const encoder = new TextEncoder();
  let head = "";
  for (const [name, value] of Object.entries(fields)) {
    head += `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  }
  head +=
    `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${quote(file.fileName)}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`;
  const headBytes = encoder.encode(head);
  const tailBytes = encoder.encode(`\r\n--${boundary}--\r\n`);

  async function* chunks(): AsyncGenerator<Uint8Array> {
    yield headBytes;
    yield* file.open();
    yield tailBytes;
  }
  const iterator = chunks();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { value, done } = await iterator.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    length: headBytes.byteLength + size + tailBytes.byteLength,
    body,
  };
}

/**
 * A filename inside a quoted header parameter: the backslash escapes the
 * server's parser (Go's mime package) reads, and no line breaks, which would
 * end the header.
 */
function quote(name: string): string {
  return name.replace(/[\r\n]/g, " ").replace(/[\\"]/g, (c) => `\\${c}`);
}
