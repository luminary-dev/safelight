import "server-only";
import { getLogger } from "@/lib/log";
import { appendEvent, type RunStatus } from "./runs-store";
import type { AgentEvent } from "./tools";

/**
 * In-process registry of detached agent runs. A run started by an HTTP request
 * lives here, not in the request: the NDJSON response is only a view onto the
 * run, so a client disconnect merely unsubscribes while the loop keeps going,
 * a reloaded page can re-attach, and POST /api/runs/[id]/stop is what actually
 * cancels. The map is anchored on globalThis so dev-server module reloads
 * cannot orphan a running loop's entry.
 *
 * The registry also owns the persisted event sequence for detached runs: every
 * published event writes through to the runs store (best-effort) under one
 * monotonic counter, then fans out to subscribers with that seq, which lets a
 * re-attaching stream replay from the DB and dedupe the live boundary by seq.
 */

/** What routes stream to clients: agent events plus the run-id announcement. */
export type RunStreamEvent = AgentEvent | { type: "run"; id: string };

export interface RunSubscriber {
  /** One published event with its persisted sequence number. */
  event: (event: AgentEvent, seq: number) => void;
  /** Called exactly once when the run finishes (any status); after this, no more events. */
  end: (status: RunStatus) => void;
}

export interface RunEntry {
  controller: AbortController;
  subscribers: Set<RunSubscriber>;
  /** Next event sequence number == count of events published so far. */
  seq: number;
  done: boolean;
  clientId: string;
  startedAt: number;
  /** Final status once done. */
  status: RunStatus;
  /** Events still write through to the runs store; flips off after a DB failure. */
  persist: boolean;
  capTimer: ReturnType<typeof setTimeout> | null;
  dropTimer: ReturnType<typeof setTimeout> | null;
}

/** Hard safety: an abandoned run is aborted after this wall-clock cap. */
export const DEFAULT_RUN_CAP_MS = 15 * 60 * 1000;
/** The cap is budget-overridable, but never beyond this. */
export const MAX_RUN_CAP_MS = 6 * 60 * 60 * 1000;
/** Finished entries linger this long so late re-attaches still resolve, then drop. */
export const DROP_DONE_AFTER_MS = 5 * 60 * 1000;

type RegistryGlobal = typeof globalThis & { __safelightRunRegistry?: Map<string, RunEntry> };

function registry(): Map<string, RunEntry> {
  const g = globalThis as RegistryGlobal;
  g.__safelightRunRegistry ??= new Map();
  return g.__safelightRunRegistry;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Registers a new run. The entry's controller is the ONLY way the run is ever aborted. */
export function registerRun(id: string, clientId: string, opts: { maxMs?: number; persist?: boolean } = {}): RunEntry {
  const capMs = Math.max(1000, Math.min(MAX_RUN_CAP_MS, opts.maxMs ?? DEFAULT_RUN_CAP_MS));
  const entry: RunEntry = {
    controller: new AbortController(),
    subscribers: new Set(),
    seq: 0,
    done: false,
    clientId,
    startedAt: Date.now(),
    status: "running",
    persist: opts.persist ?? true,
    capTimer: null,
    dropTimer: null,
  };
  entry.capTimer = setTimeout(() => {
    if (entry.done) return;
    getLogger().warn({ runId: id, capMs }, "run hit its wall-clock cap; aborting");
    publishRunEvent(id, { type: "status", text: `Stopped: the run hit its ${Math.round(capMs / 60000)}-minute time cap.` });
    entry.controller.abort();
  }, capMs);
  registry().set(id, entry);
  return entry;
}

export function getRunEntry(id: string): RunEntry | undefined {
  return registry().get(id);
}

/**
 * Persists (write-through, best-effort) and fans out one event under the run's
 * sequence counter. Publishing to an unknown or finished run is a no-op, so a
 * straggler tool event after the cap fired cannot corrupt the log.
 */
export function publishRunEvent(id: string, event: AgentEvent): void {
  const entry = registry().get(id);
  if (!entry || entry.done) return;
  const seq = entry.seq++;
  if (entry.persist) {
    try {
      appendEvent(id, seq, event);
    } catch (err) {
      entry.persist = false; // stop hammering a broken DB; live subscribers are unaffected
      getLogger().warn({ runId: id, err: errMsg(err) }, "event persistence failed; disabling write-through for this run");
    }
  }
  for (const sub of entry.subscribers) {
    try {
      sub.event(event, seq);
    } catch {
      // one broken subscriber never takes down the run or its other viewers
    }
  }
}

/** Attaches a viewer; returns an unsubscribe fn, or null when the run is unknown or already done. */
export function subscribeRun(id: string, sub: RunSubscriber): (() => void) | null {
  const entry = registry().get(id);
  if (!entry || entry.done) return null;
  entry.subscribers.add(sub);
  return () => entry.subscribers.delete(sub);
}

export function unsubscribeRun(id: string, sub: RunSubscriber): void {
  registry().get(id)?.subscribers.delete(sub);
}

/** Marks the run finished, notifies every subscriber once, and schedules the entry drop. */
export function completeRun(id: string, status: RunStatus): void {
  const entry = registry().get(id);
  if (!entry || entry.done) return;
  entry.done = true;
  entry.status = status === "running" ? "done" : status;
  if (entry.capTimer) clearTimeout(entry.capTimer);
  entry.capTimer = null;
  const subs = [...entry.subscribers];
  entry.subscribers.clear();
  for (const sub of subs) {
    try {
      sub.end(entry.status);
    } catch {
      /* ignore */
    }
  }
  entry.dropTimer = setTimeout(() => registry().delete(id), DROP_DONE_AFTER_MS);
}

/** Explicit cancel, used by POST /api/runs/[id]/stop. */
export function stopRun(id: string): "stopping" | "finished" | "unknown" {
  const entry = registry().get(id);
  if (!entry) return "unknown";
  if (entry.done) return "finished";
  entry.controller.abort();
  return "stopping";
}

/** The newest still-running run for a client id, if any — what a reloaded page asks for. */
export function activeRunFor(clientId: string): { id: string; startedAt: number; seq: number } | null {
  let best: { id: string; startedAt: number; seq: number } | null = null;
  for (const [id, entry] of registry()) {
    if (entry.done || entry.clientId !== clientId) continue;
    if (!best || entry.startedAt > best.startedAt) best = { id, startedAt: entry.startedAt, seq: entry.seq };
  }
  return best;
}

/** Test hook: clears every entry and its timers. */
export function resetRunRegistryForTests(): void {
  for (const entry of registry().values()) {
    if (entry.capTimer) clearTimeout(entry.capTimer);
    if (entry.dropTimer) clearTimeout(entry.dropTimer);
    entry.controller.abort();
  }
  registry().clear();
}
