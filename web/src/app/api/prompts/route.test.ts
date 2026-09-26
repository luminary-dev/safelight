import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resetDbForTests } from "@/lib/db";
import { DELETE, GET, POST } from "./route";

/** /api/prompts: saved-prompt CRUD and search against a sandboxed database (TEST-BRIEF §8). */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-prompts-api-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function post(body: unknown): Promise<Response> {
  return POST(
    new NextRequest(
      new Request("http://localhost:3001/api/prompts", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }),
    ),
  );
}

function get(query = ""): Promise<Response> {
  return GET(new NextRequest(new Request(`http://localhost:3001/api/prompts${query}`)));
}

function del(query = ""): Promise<Response> {
  return DELETE(new NextRequest(new Request(`http://localhost:3001/api/prompts${query}`, { method: "DELETE" })));
}

interface SavedPrompt {
  id: string;
  title: string;
  text: string;
  negative: string;
  tags: string[];
}

describe("CRUD", () => {
  it("creates, lists, updates and deletes a prompt", async () => {
    const created = await post({ title: "Portrait", text: "a portrait, 85mm", tags: ["photo"] });
    expect(created.status).toBe(200);
    const { prompt } = (await created.json()) as { prompt: SavedPrompt };
    expect(prompt.id).toBeTruthy();
    expect(prompt.tags).toEqual(["photo"]);

    const listed = (await (await get()).json()) as { prompts: SavedPrompt[] };
    expect(listed.prompts.map((p) => p.title)).toEqual(["Portrait"]);

    const updated = await post({ id: prompt.id, title: "Portrait v2", text: "a portrait, 50mm" });
    expect(((await updated.json()) as { prompt: SavedPrompt }).prompt.title).toBe("Portrait v2");
    expect(((await (await get()).json()) as { prompts: SavedPrompt[] }).prompts).toHaveLength(1);

    const removed = await del(`?id=${prompt.id}`);
    expect(removed.status).toBe(200);
    expect(await removed.json()).toEqual({ ok: true });
    expect(((await (await get()).json()) as { prompts: SavedPrompt[] }).prompts).toEqual([]);
  });

  it("filters with ?q= by title or tag, case-insensitively", async () => {
    await post({ title: "Moody forest", text: "trees", tags: ["landscape"] });
    await post({ title: "Studio portrait", text: "person", tags: ["photo"] });
    const byTitle = (await (await get("?q=FOREST")).json()) as { prompts: SavedPrompt[] };
    expect(byTitle.prompts.map((p) => p.title)).toEqual(["Moody forest"]);
    const byTag = (await (await get("?q=photo")).json()) as { prompts: SavedPrompt[] };
    expect(byTag.prompts.map((p) => p.title)).toEqual(["Studio portrait"]);
  });
});

describe("validation", () => {
  it("rejects malformed JSON with 400", async () => {
    expect((await post("{nope")).status).toBe(400);
  });

  it("rejects a prompt missing its title or text with 400, never 500", async () => {
    const noTitle = await post({ text: "words" });
    expect(noTitle.status).toBe(400);
    expect(((await noTitle.json()) as { error: string }).error).toMatch(/needs a title/i);
    expect((await post({ title: "T" })).status).toBe(400);
  });

  it("DELETE without an id is 400; an unknown id is 404", async () => {
    expect((await del()).status).toBe(400);
    const missing = await del("?id=no-such-prompt");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false });
  });
});
