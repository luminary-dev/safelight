import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDbForTests } from "@/lib/db";
import {
  activeRunFor,
  completeRun,
  DEFAULT_RUN_CAP_MS,
  DROP_DONE_AFTER_MS,
  getRunEntry,
  publishRunEvent,
  registerRun,
  resetRunRegistryForTests,
  stopRun,
  subscribeRun,
  unsubscribeRun,
  type RunSubscriber,
} from "./run-registry";
import { createRun, getRun } from "./runs-store";
import type { AgentEvent } from "./tools";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "sl-registry-"));
  process.env.SAFELIGHT_DATA_DIR = dir;
  resetDbForTests();
  resetRunRegistryForTests();
});

afterEach(async () => {
  vi.useRealTimers();
  resetRunRegistryForTests();
  resetDbForTests();
  delete process.env.SAFELIGHT_DATA_DIR;
  await rm(dir, { recursive: true, force: true });
});

function seedRow(id: string, clientId = "client-1") {
  createRun({ id, clientId, mode: "agent", provider: "ollama", model: "m" });
}

function collector(): { sub: RunSubscriber; events: { event: AgentEvent; seq: number }[]; ended: string[] } {
  const events: { event: AgentEvent; seq: number }[] = [];
  const ended: string[] = [];
  return { events, ended, sub: { event: (event, seq) => events.push({ event, seq }), end: (status) => ended.push(status) } };
}

describe("run registry", () => {
  it("publishes with a monotonic seq, write-through to the runs store, and fan-out", () => {
    seedRow("r1");
    registerRun("r1", "client-1");
    const a = collector();
    const b = collector();
    subscribeRun("r1", a.sub);
    subscribeRun("r1", b.sub);
    publishRunEvent("r1", { type: "status", text: "run r1" });
    publishRunEvent("r1", { type: "text", text: "hello" });
    expect(a.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(b.events[1].event).toEqual({ type: "text", text: "hello" });
    // Persisted under the same sequence numbers.
    const back = getRun("r1")!;
    expect(back.events.map((e) => e.seq)).toEqual([0, 1]);
    expect(back.events.map((e) => e.data)).toEqual([
      { type: "status", text: "run r1" },
      { type: "text", text: "hello" },
    ]);
  });

  it("keeps fanning out after a persistence failure (no run row → FK failure flips persist off)", () => {
    registerRun("orphan", "client-1"); // no agent_runs row: appendEvent will throw
    const c = collector();
    subscribeRun("orphan", c.sub);
    publishRunEvent("orphan", { type: "text", text: "a" });
    publishRunEvent("orphan", { type: "text", text: "b" });
    expect(getRunEntry("orphan")!.persist).toBe(false);
    expect(c.events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it("unsubscribe stops the fan-out without touching the run", () => {
    seedRow("r2");
    const entry = registerRun("r2", "client-1");
    const c = collector();
    subscribeRun("r2", c.sub);
    unsubscribeRun("r2", c.sub);
    publishRunEvent("r2", { type: "text", text: "x" });
    expect(c.events).toHaveLength(0);
    expect(entry.controller.signal.aborted).toBe(false);
    expect(entry.done).toBe(false);
  });

  it("completeRun notifies each subscriber once, then refuses new events and subscriptions", () => {
    seedRow("r3");
    registerRun("r3", "client-1");
    const c = collector();
    subscribeRun("r3", c.sub);
    completeRun("r3", "done");
    completeRun("r3", "error"); // second completion is a no-op
    expect(c.ended).toEqual(["done"]);
    publishRunEvent("r3", { type: "text", text: "late" });
    expect(c.events).toHaveLength(0);
    expect(subscribeRun("r3", c.sub)).toBeNull();
    expect(getRunEntry("r3")!.status).toBe("done");
  });

  it("stopRun aborts a live run, and reports finished/unknown otherwise", () => {
    seedRow("r4");
    const entry = registerRun("r4", "client-1");
    expect(stopRun("missing")).toBe("unknown");
    expect(stopRun("r4")).toBe("stopping");
    expect(entry.controller.signal.aborted).toBe(true);
    completeRun("r4", "stopped");
    expect(stopRun("r4")).toBe("finished");
  });

  it("activeRunFor returns the newest still-running run for that client id only", () => {
    seedRow("old", "c1");
    seedRow("new", "c1");
    seedRow("other", "c2");
    seedRow("finished", "c1");
    registerRun("old", "c1").startedAt = 1000;
    registerRun("new", "c1").startedAt = 2000;
    registerRun("other", "c2");
    registerRun("finished", "c1");
    completeRun("finished", "done");
    expect(activeRunFor("c1")?.id).toBe("new");
    expect(activeRunFor("c2")?.id).toBe("other");
    expect(activeRunFor("c3")).toBeNull();
  });

  it("the wall-clock cap aborts an abandoned run and narrates it (default 15 min)", () => {
    vi.useFakeTimers();
    seedRow("capped");
    const entry = registerRun("capped", "client-1");
    const c = collector();
    subscribeRun("capped", c.sub);
    vi.advanceTimersByTime(DEFAULT_RUN_CAP_MS + 1);
    expect(entry.controller.signal.aborted).toBe(true);
    expect(c.events[0].event).toEqual({ type: "status", text: "Stopped: the run hit its 15-minute time cap." });
  });

  it("honors a custom cap and drops finished entries after the retention window", () => {
    vi.useFakeTimers();
    seedRow("short");
    const entry = registerRun("short", "client-1", { maxMs: 2000 });
    vi.advanceTimersByTime(2001);
    expect(entry.controller.signal.aborted).toBe(true);
    completeRun("short", "stopped");
    vi.advanceTimersByTime(DROP_DONE_AFTER_MS + 1);
    expect(getRunEntry("short")).toBeUndefined();
    // The persisted log survives the registry drop.
    expect(getRun("short")).not.toBeNull();
  });
});
