import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMcpServers } from "@/lib/agent/mcp";
import { resetDbForTests } from "@/lib/db";
import { MCP_STDIO_SCRIPT, startHttpMcp, type FakeHttpMcp } from "@/test/fakes/mcp-server";
import { DELETE, GET, PATCH, POST } from "./route";

/**
 * /api/mcp (TEST-BRIEF §8): add/list/toggle/remove servers, live probing of
 * enabled ones (via the stdio and HTTP MCP fakes), an unreachable server as a
 * status error, and the invalid-tool-schema behavior. Configs live in the
 * sandboxed settings table.
 */

let dir: string;
let httpMcp: FakeHttpMcp | null = null;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-mcp-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  // Deleting every server also drops pooled connections (and stdio children).
  for (const s of listMcpServers()) await DELETE(req(`/api/mcp?id=${s.id}`, { method: "DELETE" }));
  if (httpMcp) {
    await httpMcp.close();
    httpMcp = null;
  }
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function req(url: string, init?: RequestInit): NextRequest {
  return new NextRequest(new Request(`http://localhost:3001${url}`, init));
}

function post(body: unknown): Promise<Response> {
  return POST(req("/api/mcp", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
}

interface ServerView {
  id: string;
  name: string;
  enabled: boolean;
  status: "ok" | "error" | "off";
  tools: { name: string; readOnly: boolean }[];
  error?: string;
}

async function list(): Promise<ServerView[]> {
  return ((await (await GET()).json()) as { servers: ServerView[] }).servers;
}

describe("add + list + probe", () => {
  it("adds an HTTP server and probes its tools live, with read-only hints intact", async () => {
    httpMcp = await startHttpMcp("ok");
    const added = await post({ name: "My Tools", transport: "http", url: httpMcp.url });
    expect(added.status).toBe(200);
    expect(await added.json()).toEqual({ ok: true, id: "my-tools" });

    const servers = await list();
    expect(servers).toHaveLength(1);
    expect(servers[0].status).toBe("ok");
    expect(servers[0].tools.map((t) => [t.name, t.readOnly])).toEqual([
      ["echo", true],
      ["wipe_data", false],
    ]);
  });

  it("adds a stdio server (args as a shell-ish string) and probes it through a real child process", async () => {
    const added = await post({ name: "Stdio Fake", transport: "stdio", command: process.execPath, args: `${MCP_STDIO_SCRIPT} ok` });
    expect(added.status).toBe(200);
    const servers = await list();
    expect(servers[0].status).toBe("ok");
    expect(servers[0].tools.map((t) => t.name)).toEqual(["echo", "wipe_data"]);
  });

  it("reports an unreachable server as a status error, not a failed request", async () => {
    await post({ name: "Gone", transport: "http", url: "http://127.0.0.1:9/mcp" });
    const servers = await list();
    expect(servers[0].status).toBe("error");
    expect(servers[0].error).toBeTruthy();
    expect(servers[0].tools).toEqual([]);
  });

  it("still lists a server whose tools/list returns an invalid schema (validation is deferred to call time)", async () => {
    // lib/agent/mcp does not reject a non-object inputSchema at probe time; this
    // pins the current contract at the route level. See the tier report: schema
    // validation ("invalid schema rejected", TEST-BRIEF §9) lives with Tier 4.
    await post({ name: "Broken Schema", transport: "stdio", command: process.execPath, args: [MCP_STDIO_SCRIPT, "invalid-schema"] });
    const servers = await list();
    expect(servers[0].status).toBe("ok");
    expect(servers[0].tools.map((t) => t.name)).toEqual(["broken"]);
  });
});

describe("toggle + remove", () => {
  it("PATCH disables a server (listed as off, not probed) and re-enables it", async () => {
    httpMcp = await startHttpMcp("ok");
    await post({ name: "My Tools", transport: "http", url: httpMcp.url });
    const off = await PATCH(req("/api/mcp", { method: "PATCH", body: JSON.stringify({ id: "my-tools", enabled: false }) }));
    expect(await off.json()).toEqual({ ok: true });
    let servers = await list();
    expect(servers[0]).toMatchObject({ status: "off", enabled: false, tools: [] });

    await PATCH(req("/api/mcp", { method: "PATCH", body: JSON.stringify({ id: "my-tools", enabled: true }) }));
    servers = await list();
    expect(servers[0].status).toBe("ok");
  });

  it("PATCH on an unknown id is 404; malformed JSON is 400", async () => {
    expect((await PATCH(req("/api/mcp", { method: "PATCH", body: JSON.stringify({ id: "ghost", enabled: true }) }))).status).toBe(404);
    expect((await PATCH(req("/api/mcp", { method: "PATCH", body: "{oops" }))).status).toBe(400);
  });

  it("DELETE removes the server; DELETE without an id is 400", async () => {
    httpMcp = await startHttpMcp("ok");
    await post({ name: "My Tools", transport: "http", url: httpMcp.url });
    expect(await (await DELETE(req("/api/mcp?id=my-tools", { method: "DELETE" }))).json()).toEqual({ ok: true });
    expect(await list()).toEqual([]);
    expect((await DELETE(req("/api/mcp", { method: "DELETE" }))).status).toBe(400);
  });
});

describe("validation", () => {
  it("rejects malformed JSON, a bad transport, and a missing name with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
    expect((await post({ name: "X", transport: "carrier-pigeon" })).status).toBe(400);
    expect((await post({ transport: "http", url: "http://127.0.0.1:9" })).status).toBe(400);
  });

  it("rejects a stdio server without a command and an http server with a garbage URL", async () => {
    expect((await post({ name: "NoCmd", transport: "stdio" })).status).toBe(400);
    expect((await post({ name: "BadUrl", transport: "http", url: "not a url" })).status).toBe(400);
    expect((await post({ name: "BadProto", transport: "http", url: "file:///etc/passwd" })).status).toBe(400);
  });

  it("rejects an id that does not slugify cleanly", async () => {
    expect((await post({ id: "UPPER CASE!!", name: "X", transport: "stdio", command: "true" })).status).toBe(400);
  });
});
