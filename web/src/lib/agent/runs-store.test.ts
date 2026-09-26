import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getDb, resetDbForTests } from "@/lib/db";
import { appendEvent, createRun, finishRun, getEventsSince, getRun, getRunRow, listRuns, MAX_STORED_RUNS } from "./runs-store";
import type { AgentEvent } from "./tools";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-runs-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function seed(id: string, startedAt: number) {
  createRun({ id, clientId: "agent", mode: "agent", provider: "openai", model: "gpt-5-mini", startedAt });
}

describe("runs store", () => {
  it("round-trips a run with its ordered events", () => {
    seed("r1", 1000);
    const events: AgentEvent[] = [
      { type: "status", text: "run r1" },
      { type: "tool", id: "t1", name: "generate_image", args: { prompt: "x" }, state: "running" },
      { type: "text", text: "done!" },
    ];
    events.forEach((e, i) => appendEvent("r1", i, e, 2000 + i));
    finishRun("r1", "done", undefined, 9000);

    const back = getRun("r1");
    expect(back).not.toBeNull();
    expect(back!.run).toMatchObject({ id: "r1", clientId: "agent", mode: "agent", provider: "openai", model: "gpt-5-mini", status: "done", startedAt: 1000, finishedAt: 9000, error: null });
    expect(back!.events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(back!.events.map((e) => e.data)).toEqual(events);
    expect(getRun("missing")).toBeNull();
  });

  it("getRunRow returns the row alone and getEventsSince replays from a sequence", () => {
    seed("r5", 1000);
    const events: AgentEvent[] = [
      { type: "status", text: "run r5" },
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ];
    events.forEach((e, i) => appendEvent("r5", i, e));
    expect(getRunRow("r5")).toMatchObject({ id: "r5", status: "running" });
    expect(getRunRow("missing")).toBeNull();
    expect(getEventsSince("r5").map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(getEventsSince("r5", 1).map((e) => e.data)).toEqual([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]);
    expect(getEventsSince("r5", 3)).toEqual([]);
    expect(getEventsSince("r5", -2).map((e) => e.seq)).toEqual([0, 1, 2]); // negative clamps to 0
  });

  it("records error status with the message", () => {
    seed("r2", 1000);
    finishRun("r2", "error", "Provider exploded.");
    expect(getRun("r2")!.run).toMatchObject({ status: "error", error: "Provider exploded." });
  });

  it("lists newest first with a limit", () => {
    seed("old", 1000);
    seed("mid", 2000);
    seed("new", 3000);
    expect(listRuns(10).map((r) => r.id)).toEqual(["new", "mid", "old"]);
    expect(listRuns(2).map((r) => r.id)).toEqual(["new", "mid"]);
  });

  it("prunes the oldest runs (and their events) beyond the cap on insert", () => {
    for (let i = 0; i < MAX_STORED_RUNS + 5; i++) {
      seed(`run-${String(i).padStart(3, "0")}`, 1000 + i);
      appendEvent(`run-${String(i).padStart(3, "0")}`, 0, { type: "status", text: "hi" });
    }
    const rows = listRuns(MAX_STORED_RUNS);
    expect(rows).toHaveLength(MAX_STORED_RUNS);
    const ids = rows.map((r) => r.id);
    expect(ids).not.toContain("run-000");
    expect(ids).not.toContain("run-004");
    expect(ids).toContain("run-005");
    const counts = getDb().prepare("SELECT (SELECT COUNT(*) FROM agent_runs) AS runs, (SELECT COUNT(*) FROM agent_events) AS events").get() as { runs: number; events: number };
    expect(counts.runs).toBe(MAX_STORED_RUNS);
    expect(counts.events).toBe(MAX_STORED_RUNS); // cascade removed the pruned runs' events
  });
});
