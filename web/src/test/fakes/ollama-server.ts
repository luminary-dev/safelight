import type { ServerResponse } from "node:http";
import { sendJson, startFakeServer, type FakeServer } from "./http";

/**
 * In-process fake Ollama: /api/tags, /api/show (capabilities), /api/chat
 * (NDJSON streaming), /api/ps, and /api/generate for the keep_alive:0 unload.
 *
 * Scripting API:
 *   const ollama = await startFakeOllama();
 *   ollama.setModels([{ name: "llava:13b", capabilities: ["completion", "vision"] }]);
 *   ollama.scriptChat(["Hel", "lo"]);                          // happy stream
 *   ollama.scriptChat(["Hel"], { errorAfter: "boom" });        // mid-stream {"error": …} line
 *   ollama.scriptChat(["Hel", "lo"], { truncateAfter: 1 });    // stream ends with no done:true
 *   ollama.scriptChat(deltas, { chunkBytes: 3 });              // splits NDJSON lines across chunks
 *   ollama.setResident(["llama3:8b"]);                         // what /api/ps reports
 *   ollama.unloads                                             // keep_alive:0 requests seen
 *   await ollama.close();                                      // offline from here on
 *
 * "Offline" is simply a closed (or never-started) server: point OLLAMA_URL at
 * ollama.url after close(), or at an unreachable port.
 */

export interface FakeOllamaModel {
  name: string;
  size?: number;
  details?: { parameter_size?: string; quantization_level?: string; family?: string };
  /** e.g. ["completion", "vision", "tools"]. A model without "tools" is the no-tools case. */
  capabilities?: string[];
}

export interface ChatScriptOptions {
  /** Emit an NDJSON {"error": …} line after the deltas. */
  errorAfter?: string;
  /** Truncate: end the stream after this many delta lines with no done:true line. */
  truncateAfter?: number;
  /** Write the NDJSON body in chunks of this many bytes, splitting lines mid-way. */
  chunkBytes?: number;
  /** Answer this HTTP status instead of streaming. */
  status?: number;
}

export interface FakeOllama extends FakeServer {
  setModels(models: FakeOllamaModel[]): void;
  setResident(names: string[]): void;
  scriptChat(deltas: string[], opts?: ChatScriptOptions): void;
  /** Bodies of /api/generate calls that asked for keep_alive: 0. */
  unloads: { model: string }[];
  /** Every /api/chat request body, for "the model/messages sent were right" assertions. */
  chatRequests: { model: string; messages: unknown[]; stream?: boolean }[];
}

function writeChunked(res: ServerResponse, text: string, chunkBytes: number | undefined): void {
  if (!chunkBytes || chunkBytes <= 0) {
    res.write(text);
    return;
  }
  const buf = Buffer.from(text, "utf8");
  for (let i = 0; i < buf.length; i += chunkBytes) res.write(buf.subarray(i, i + chunkBytes));
}

export async function startFakeOllama(): Promise<FakeOllama> {
  let models: FakeOllamaModel[] = [];
  let resident: string[] = [];
  let chatScript: { deltas: string[]; opts: ChatScriptOptions } = { deltas: ["Hello from fake Ollama."], opts: {} };
  const unloads: { model: string }[] = [];
  const chatRequests: { model: string; messages: unknown[]; stream?: boolean }[] = [];

  const base = await startFakeServer((req, res, body) => {
    const url = new URL(req.url ?? "/", "http://fake");

    if (url.pathname === "/api/tags") {
      sendJson(res, 200, { models: models.map(({ name, size, details }) => ({ name, size: size ?? 4_000_000_000, details })) });
      return;
    }

    if (url.pathname === "/api/show" && req.method === "POST") {
      const parsed = JSON.parse(body.toString("utf8") || "{}") as { model?: string; name?: string };
      const model = models.find((m) => m.name === (parsed.model ?? parsed.name));
      if (!model) {
        sendJson(res, 404, { error: `model '${parsed.model}' not found` });
        return;
      }
      sendJson(res, 200, { capabilities: model.capabilities ?? ["completion"], details: model.details ?? {} });
      return;
    }

    if (url.pathname === "/api/chat" && req.method === "POST") {
      const parsed = JSON.parse(body.toString("utf8") || "{}") as { model?: string; messages?: unknown[]; stream?: boolean };
      chatRequests.push({ model: parsed.model ?? "", messages: parsed.messages ?? [], stream: parsed.stream });
      const { deltas, opts } = chatScript;
      if (opts.status) {
        sendJson(res, opts.status, { error: `fake ollama scripted ${opts.status}` });
        return;
      }
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      let lines = deltas.map((content) => JSON.stringify({ model: parsed.model, message: { role: "assistant", content }, done: false }) + "\n");
      if (opts.truncateAfter !== undefined) {
        lines = lines.slice(0, opts.truncateAfter);
        writeChunked(res, lines.join(""), opts.chunkBytes);
        res.end(); // truncated: the stream just stops, no done:true ever arrives
        return;
      }
      if (opts.errorAfter !== undefined) lines.push(JSON.stringify({ error: opts.errorAfter }) + "\n");
      else lines.push(JSON.stringify({ model: parsed.model, message: { role: "assistant", content: "" }, done: true, done_reason: "stop" }) + "\n");
      writeChunked(res, lines.join(""), opts.chunkBytes);
      res.end();
      return;
    }

    if (url.pathname === "/api/ps") {
      sendJson(res, 200, { models: resident.map((name) => ({ name, size: 4_000_000_000 })) });
      return;
    }

    if (url.pathname === "/api/generate" && req.method === "POST") {
      const parsed = JSON.parse(body.toString("utf8") || "{}") as { model?: string; keep_alive?: number };
      if (parsed.keep_alive === 0) {
        unloads.push({ model: parsed.model ?? "" });
        resident = resident.filter((n) => n !== parsed.model);
      }
      sendJson(res, 200, { model: parsed.model, done: true, done_reason: "unload" });
      return;
    }

    sendJson(res, 404, { error: `no fake route for ${req.method} ${url.pathname}` });
  });

  return {
    ...base,
    unloads,
    chatRequests,
    setModels: (m) => {
      models = m;
    },
    setResident: (names) => {
      resident = names;
    },
    scriptChat: (deltas, opts = {}) => {
      chatScript = { deltas, opts };
    },
  };
}
