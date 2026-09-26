import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { HistoryEntry, QueueEntryTuple } from "@/lib/comfy/client";
import { closeServer, listenOn, readBody, sendJson, TINY_PNG } from "./http";

/**
 * In-process fake ComfyUI speaking the subset Safelight uses:
 * /system_stats, /models/:folder, /object_info(/:class), POST /prompt,
 * /history/:id, GET+POST /queue, /interrupt, /upload/image, /view, and the
 * progress WebSocket at /ws.
 *
 * The progress socket is a minimal RFC 6455 server (no `ws` dependency exists
 * in this repo): text frames only, no extensions, server→client push. That is
 * exactly what ComfyUI's progress feed needs.
 *
 * Scripting API (what a test writes against):
 *   const comfy = await startFakeComfy();
 *   comfy.setFolder("checkpoints", ["sd_xl_base_1.0.safetensors"]);
 *   comfy.failNextPrompt({ message: "…" }, nodeErrors);   // POST /prompt → 400 + node_errors
 *   comfy.queueThenHistoryError("CUDA out of memory");    // queue ok, history reports error
 *   comfy.scriptView404();                                // /view → 404 once
 *   comfy.scriptProgressThenDrop(5, 25);                  // on ws connect: 5 ticks of 25, then drop
 *   await comfy.restart();                                // same port, output counter reset
 *   comfy.close();
 */

export interface FakeComfyPromptFailure {
  message: string;
  nodeErrors?: Record<string, { errors: { message: string; details?: string }[] }>;
}

interface WsClient {
  socket: Duplex;
}

export interface FakeComfy {
  url: string;
  wsUrl: string;
  port: number;
  /** Every request seen, for "the client called X" assertions. */
  requests: { method: string; path: string }[];
  /** Uploaded files recorded by POST /upload/image. */
  uploads: { filename: string; subfolder: string; bytes: number }[];

  setFolder(folder: string, names: string[]): void;
  setObjectInfo(nodeClass: string, info: unknown): void;
  removeObjectInfo(nodeClass: string): void;

  /** When false, POST /prompt leaves the job pending until completePrompt/markRunning. Default true. */
  setAutoComplete(on: boolean): void;
  /** Next POST /prompt answers 400 with { error, node_errors }. One-shot. */
  failNextPrompt(failure: FakeComfyPromptFailure): void;
  /** Queueing succeeds but the history entry reports status error with this message. Sticky until reset. */
  queueThenHistoryError(message?: string): void;
  /** Next GET /view answers 404. One-shot. */
  scriptView404(): void;
  /** On the next ws connect: `ticks` progress frames out of `max`, then the socket is destroyed. */
  scriptProgressThenDrop(ticks: number, max: number, promptId?: string): void;

  /** Manual completion for setAutoComplete(false). */
  markRunning(promptId: string): void;
  completePrompt(promptId: string, outputs?: { filename: string; subfolder: string; type: string }[]): void;

  /** Number of live ws clients. */
  wsClientCount(): number;
  /** Pushes one JSON text frame to every connected ws client. */
  pushWs(message: unknown): void;
  sendProgress(promptId: string, value: number, max: number): void;
  /** Destroys every ws socket without a close frame — the "socket drops" scenario. */
  dropWsClients(): void;

  /** Simulates a ComfyUI restart: same port, fresh state, output counter back to 1. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeTextFrame(data: string): Buffer {
  const payload = Buffer.from(data, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Very small multipart parser: returns fields and the first file part per name. */
function parseMultipart(body: Buffer, contentType: string): { fields: Record<string, string>; files: Record<string, { filename: string; bytes: Buffer }> } {
  const fields: Record<string, string> = {};
  const files: Record<string, { filename: string; bytes: Buffer }> = {};
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(contentType);
  const b = boundary?.[1] ?? boundary?.[2];
  if (!b) return { fields, files };
  const sep = Buffer.from(`--${b}`);
  let idx = body.indexOf(sep);
  while (idx >= 0) {
    const next = body.indexOf(sep, idx + sep.length);
    if (next < 0) break;
    const part = body.subarray(idx + sep.length, next);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd >= 0) {
      const header = part.subarray(0, headerEnd).toString("utf8");
      const content = part.subarray(headerEnd + 4, part.length - 2); // strip trailing \r\n
      const name = /name="([^"]+)"/.exec(header)?.[1];
      const filename = /filename="([^"]*)"/.exec(header)?.[1];
      if (name && filename !== undefined) files[name] = { filename, bytes: content };
      else if (name) fields[name] = content.toString("utf8");
    }
    idx = next;
  }
  return { fields, files };
}

const DEFAULT_OBJECT_INFO: Record<string, unknown> = {
  KSampler: {
    input: {
      required: {
        sampler_name: [["euler", "euler_ancestral", "dpmpp_2m", "res_multistep"]],
        scheduler: [["simple", "normal", "karras", "beta"]],
        seed: [{ default: 0 }],
      },
    },
  },
  SaveImage: { input: { required: { images: [["IMAGE"]] } } },
  LoadImage: { input: { required: { image: [[]] } } },
  CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } },
};

export async function startFakeComfy(): Promise<FakeComfy> {
  // ---- mutable state, reset by restart() ----
  let folders: Record<string, string[]> = { checkpoints: [], diffusion_models: [], unet_gguf: [], text_encoders: [], vae: [], loras: [] };
  let objectInfo: Record<string, unknown> = { ...DEFAULT_OBJECT_INFO };
  let history: Record<string, HistoryEntry> = {};
  let pending: QueueEntryTuple[] = [];
  let running: QueueEntryTuple[] = [];
  let outputCounter = 1;
  let promptSeq = 0;
  let queueNumber = 0;
  let autoComplete = true;
  let promptFailure: FakeComfyPromptFailure | null = null;
  let historyErrorMessage: string | null = null;
  let view404Once = false;
  let progressScript: { ticks: number; max: number; promptId: string } | null = null;
  const wsClients: WsClient[] = [];
  const requests: { method: string; path: string }[] = [];
  const uploads: { filename: string; subfolder: string; bytes: number }[] = [];

  function nextOutput(): { filename: string; subfolder: string; type: string } {
    const filename = `ComfyUI_${String(outputCounter++).padStart(5, "0")}_.png`;
    return { filename, subfolder: "safelight", type: "output" };
  }

  function successEntry(outputs: { filename: string; subfolder: string; type: string }[]): HistoryEntry {
    return { status: { status_str: "success", completed: true, messages: [] }, outputs: { "9": { images: outputs } } };
  }

  function errorEntry(message: string): HistoryEntry {
    return {
      status: { status_str: "error", completed: false, messages: [["execution_error", { exception_message: message }]] },
      outputs: {},
    };
  }

  function handle(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? "/", "http://fake");
    const p = url.pathname;
    requests.push({ method: req.method ?? "GET", path: p });

    if (p === "/system_stats") {
      sendJson(res, 200, {
        system: { os: "posix", ram_total: 68719476736, ram_free: 34359738368, comfyui_version: "0.3.0-fake", pytorch_version: "2.4.0" },
        devices: [{ name: "Fake MPS", type: "mps", vram_total: 68719476736, vram_free: 34359738368 }],
      });
      return;
    }

    if (p.startsWith("/models/")) {
      const folder = decodeURIComponent(p.slice("/models/".length));
      if (folder in folders) sendJson(res, 200, folders[folder]);
      else sendJson(res, 404, { error: "folder not found" });
      return;
    }

    if (p === "/object_info") {
      sendJson(res, 200, objectInfo);
      return;
    }
    if (p.startsWith("/object_info/")) {
      const cls = decodeURIComponent(p.slice("/object_info/".length));
      if (cls in objectInfo) sendJson(res, 200, { [cls]: objectInfo[cls] });
      else sendJson(res, 404, { error: `node class ${cls} not found` });
      return;
    }

    if (p === "/prompt" && req.method === "POST") {
      if (promptFailure) {
        const { message, nodeErrors } = promptFailure;
        promptFailure = null;
        sendJson(res, 400, { error: { message, type: "prompt_outputs_failed_validation" }, node_errors: nodeErrors ?? {} });
        return;
      }
      const parsed = JSON.parse(body.toString("utf8") || "{}") as { prompt?: Record<string, unknown>; client_id?: string; prompt_id?: string; front?: boolean };
      const id = parsed.prompt_id ?? `fake-prompt-${++promptSeq}`;
      const number = ++queueNumber;
      if (autoComplete) {
        history[id] = historyErrorMessage ? errorEntry(historyErrorMessage) : successEntry([nextOutput()]);
      } else {
        const entry: QueueEntryTuple = [number, id, parsed.prompt ?? {}, { client_id: parsed.client_id ?? "" }, []];
        if (parsed.front) pending.unshift(entry);
        else pending.push(entry);
      }
      sendJson(res, 200, { prompt_id: id, number, node_errors: {} });
      return;
    }

    if (p.startsWith("/history/")) {
      const id = decodeURIComponent(p.slice("/history/".length));
      sendJson(res, 200, history[id] ? { [id]: history[id] } : {});
      return;
    }

    if (p === "/queue" && req.method === "GET") {
      sendJson(res, 200, { queue_running: running, queue_pending: pending });
      return;
    }
    if (p === "/queue" && req.method === "POST") {
      const parsed = JSON.parse(body.toString("utf8") || "{}") as { delete?: string[]; clear?: boolean };
      if (parsed.clear) pending = [];
      if (parsed.delete) pending = pending.filter((e) => !parsed.delete!.includes(e[1]));
      sendJson(res, 200, {});
      return;
    }

    if (p === "/interrupt" && req.method === "POST") {
      for (const e of running) history[e[1]] = errorEntry("Interrupted");
      running = [];
      sendJson(res, 200, {});
      return;
    }

    if (p === "/upload/image" && req.method === "POST") {
      const { fields, files } = parseMultipart(body, req.headers["content-type"] ?? "");
      const image = files.image;
      if (!image) {
        sendJson(res, 400, { error: "no image part" });
        return;
      }
      const subfolder = fields.subfolder ?? "";
      uploads.push({ filename: image.filename, subfolder, bytes: image.bytes.length });
      sendJson(res, 200, { name: image.filename, subfolder, type: fields.type ?? "input" });
      return;
    }

    if (p === "/view") {
      if (view404Once) {
        view404Once = false;
        sendJson(res, 404, { error: "file not found" });
        return;
      }
      res.writeHead(200, { "content-type": "image/png" });
      res.end(TINY_PNG);
      return;
    }

    sendJson(res, 404, { error: `no fake route for ${req.method} ${p}` });
  }

  function makeServer(): Server {
    const server = createServer(async (req, res) => {
      const body = await readBody(req);
      try {
        handle(req, res, body);
      } catch (err) {
        if (!res.headersSent) sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      }
    });
    server.on("upgrade", (req, socket: Duplex) => {
      const key = req.headers["sec-websocket-key"];
      if (typeof key !== "string") {
        socket.destroy();
        return;
      }
      const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
      socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${accept}`, "", ""].join("\r\n"));
      const client: WsClient = { socket };
      wsClients.push(client);
      socket.on("close", () => {
        const i = wsClients.indexOf(client);
        if (i >= 0) wsClients.splice(i, 1);
      });
      socket.on("error", () => {
        /* dropped mid-test; fine */
      });
      // Incoming frames (client pings/closes) are ignored — the fake only pushes.
      socket.on("data", () => {});
      if (progressScript) {
        const { ticks, max, promptId } = progressScript;
        progressScript = null;
        for (let i = 1; i <= ticks; i++) {
          socket.write(encodeTextFrame(JSON.stringify({ type: "progress", data: { value: i, max, prompt_id: promptId } })));
        }
        socket.destroy();
      }
    });
    return server;
  }

  let server = makeServer();
  const { url, port } = await listenOn(server);

  const fake: FakeComfy = {
    url,
    wsUrl: `${url.replace(/^http/, "ws")}/ws`,
    port,
    requests,
    uploads,

    setFolder: (folder, names) => {
      folders[folder] = names;
    },
    setObjectInfo: (cls, info) => {
      objectInfo[cls] = info;
    },
    removeObjectInfo: (cls) => {
      delete objectInfo[cls];
    },

    setAutoComplete: (on) => {
      autoComplete = on;
    },
    failNextPrompt: (failure) => {
      promptFailure = failure;
    },
    queueThenHistoryError: (message = "Execution failed") => {
      historyErrorMessage = message;
    },
    scriptView404: () => {
      view404Once = true;
    },
    scriptProgressThenDrop: (ticks, max, promptId = "fake-prompt-1") => {
      progressScript = { ticks, max, promptId };
    },

    markRunning: (promptId) => {
      const i = pending.findIndex((e) => e[1] === promptId);
      if (i >= 0) running.push(...pending.splice(i, 1));
    },
    completePrompt: (promptId, outputs) => {
      pending = pending.filter((e) => e[1] !== promptId);
      running = running.filter((e) => e[1] !== promptId);
      history[promptId] = historyErrorMessage ? errorEntry(historyErrorMessage) : successEntry(outputs ?? [nextOutput()]);
    },

    wsClientCount: () => wsClients.length,
    pushWs: (message) => {
      const frame = encodeTextFrame(JSON.stringify(message));
      for (const c of wsClients) c.socket.write(frame);
    },
    sendProgress: (promptId, value, max) => {
      fake.pushWs({ type: "progress", data: { value, max, prompt_id: promptId } });
    },
    dropWsClients: () => {
      for (const c of [...wsClients]) c.socket.destroy();
      wsClients.length = 0;
    },

    restart: async () => {
      fake.dropWsClients();
      await closeServer(server);
      folders = { checkpoints: [], diffusion_models: [], unet_gguf: [], text_encoders: [], vae: [], loras: [] };
      objectInfo = { ...DEFAULT_OBJECT_INFO };
      history = {};
      pending = [];
      running = [];
      outputCounter = 1;
      promptSeq = 0;
      queueNumber = 0;
      autoComplete = true;
      promptFailure = null;
      historyErrorMessage = null;
      view404Once = false;
      progressScript = null;
      server = makeServer();
      await listenOn(server, port);
    },
    close: async () => {
      fake.dropWsClients();
      await closeServer(server);
    },
  };
  return fake;
}
