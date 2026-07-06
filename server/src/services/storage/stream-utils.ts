/**
 * Shared helper for buffering a storage download stream into memory.
 *
 * Both the NATS identity-seed restore and the full self-restore need to pull a
 * backend `getDownloadStream()` result into a single Buffer before handing it
 * to `adm-zip`. Keeping the buffering in one place means both paths agree on
 * how string vs Buffer chunks are coalesced.
 */

/**
 * Buffer a Node.js readable stream (or a stream-like object exposing the Node
 * event API) into a single Buffer.
 */
export async function bufferStream(stream: unknown): Promise<Buffer> {
  const readable = stream as NodeJS.ReadableStream;
  const chunks: Buffer[] = [];
  return new Promise<Buffer>((resolve, reject) => {
    readable.on("data", (chunk: Buffer | string) =>
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk),
    );
    readable.on("end", () => resolve(Buffer.concat(chunks)));
    readable.on("error", reject);
  });
}
