import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * Shared plumbing for the in-process fake servers. Every fake listens on
 * 127.0.0.1 with an ephemeral port so parallel test files never collide,
 * and exposes `url` + `close()` so a test can point code at it and tear
 * it down deterministically.
 */

export type RequestHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>;

export interface FakeServer {
  server: Server;
  /** e.g. "http://127.0.0.1:49321" — no trailing slash. */
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Reads the full request body. Fakes are small; no streaming needed. */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Starts an http server on 127.0.0.1:0 (or a specific port for restarts). */
export function listenOn(server: Server, port = 0): Promise<{ url: string; port: number }> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${address.port}`, port: address.port });
    });
  });
}

/** Closes the server and destroys any kept-alive sockets so close() never hangs. */
export function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.closeAllConnections?.();
    server.close(() => resolve());
  });
}

export async function startFakeServer(handler: RequestHandler): Promise<FakeServer> {
  const server = createServer(async (req, res) => {
    const body = await readBody(req);
    try {
      await handler(req, res, body);
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });
  const { url, port } = await listenOn(server);
  return { server, url, port, close: () => closeServer(server) };
}

/** Reads a whole Uint8Array stream as UTF-8 text (the dom lib types have no async iterator). */
export async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/** A 1×1 transparent PNG — enough for anything that sniffs magic bytes or decodes. */
export const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);
