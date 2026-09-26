import "server-only";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import type { AgentEvent } from "./tools";

/**
 * Persistence for agent runs (migration 4): one agent_runs row per run and one
 * agent_events row per emitted AgentEvent, so a reload can restore a run in
 * progress and old runs stay inspectable.
 *
 * Writes sit on the hot path of the agent loop, so statements are prepared once
 * per database handle. Callers on the loop should treat every write as
 * best-effort — a DB hiccup must never kill a render (see RunRecorder in run.ts).
 */

export const MAX_STORED_RUNS = 200;

export type RunStatus = "running" | "done" | "error" | "stopped";

export interface RunRow {
  id: string;
  clientId: string;
  mode: string;
  provider: string;
  model: string;
  startedAt: number;
  finishedAt: number | null;
  status: RunStatus;
  error: string | null;
}

export interface RunEventRow {
  seq: number;
  ts: number;
  data: AgentEvent;
}

interface Stmts {
  insertRun: Database.Statement;
  insertEvent: Database.Statement;
  finishRun: Database.Statement;
  prune: Database.Statement;
  listRuns: Database.Statement;
  getRun: Database.Statement;
  getEvents: Database.Statement;
  getEventsSince: Database.Statement;
}

const stmtCache = new WeakMap<Database.Database, Stmts>();

function stmts(): Stmts {
  const db = getDb();
  let s = stmtCache.get(db);
  if (!s) {
    s = {
      insertRun: db.prepare("INSERT INTO agent_runs (id, client_id, mode, provider, model, started_at, status) VALUES (?, ?, ?, ?, ?, ?, 'running')"),
      insertEvent: db.prepare("INSERT INTO agent_events (run_id, seq, ts, data) VALUES (?, ?, ?, ?)"),
      finishRun: db.prepare("UPDATE agent_runs SET status = ?, error = ?, finished_at = ? WHERE id = ?"),
      prune: db.prepare("DELETE FROM agent_runs WHERE id IN (SELECT id FROM agent_runs ORDER BY started_at DESC, id DESC LIMIT -1 OFFSET ?)"),
      listRuns: db.prepare("SELECT id, client_id, mode, provider, model, started_at, finished_at, status, error FROM agent_runs ORDER BY started_at DESC, id DESC LIMIT ?"),
      getRun: db.prepare("SELECT id, client_id, mode, provider, model, started_at, finished_at, status, error FROM agent_runs WHERE id = ?"),
      getEvents: db.prepare("SELECT seq, ts, data FROM agent_events WHERE run_id = ? ORDER BY seq ASC"),
      getEventsSince: db.prepare("SELECT seq, ts, data FROM agent_events WHERE run_id = ? AND seq >= ? ORDER BY seq ASC"),
    };
    stmtCache.set(db, s);
  }
  return s;
}

interface RawRow {
  id: string;
  client_id: string;
  mode: string;
  provider: string;
  model: string;
  started_at: number;
  finished_at: number | null;
  status: RunStatus;
  error: string | null;
}

function toRow(r: RawRow): RunRow {
  return {
    id: r.id,
    clientId: r.client_id,
    mode: r.mode,
    provider: r.provider,
    model: r.model,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    status: r.status,
    error: r.error,
  };
}

/** Inserts the run row and prunes the oldest runs beyond MAX_STORED_RUNS (events cascade). */
export function createRun(run: { id: string; clientId: string; mode: string; provider: string; model: string; startedAt?: number }): void {
  const s = stmts();
  s.insertRun.run(run.id, run.clientId, run.mode, run.provider, run.model, run.startedAt ?? Date.now());
  s.prune.run(MAX_STORED_RUNS);
}

/** Appends one emitted event. seq must be monotonic per run — the loop's recorder owns the counter. */
export function appendEvent(runId: string, seq: number, event: AgentEvent, ts = Date.now()): void {
  stmts().insertEvent.run(runId, seq, ts, JSON.stringify(event));
}

export function finishRun(runId: string, status: Exclude<RunStatus, "running">, error?: string, finishedAt = Date.now()): void {
  stmts().finishRun.run(status, error ?? null, finishedAt, runId);
}

export function listRuns(limit = 50): RunRow[] {
  const n = Math.max(1, Math.min(MAX_STORED_RUNS, Math.floor(limit) || 50));
  return (stmts().listRuns.all(n) as RawRow[]).map(toRow);
}

function parseEventRow(e: { seq: number; ts: number; data: string }): RunEventRow {
  let data: AgentEvent;
  try {
    data = JSON.parse(e.data) as AgentEvent;
  } catch {
    data = { type: "status", text: "(unreadable event)" };
  }
  return { seq: e.seq, ts: e.ts, data };
}

export function getRun(id: string): { run: RunRow; events: RunEventRow[] } | null {
  const raw = stmts().getRun.get(id) as RawRow | undefined;
  if (!raw) return null;
  const events = (stmts().getEvents.all(id) as { seq: number; ts: number; data: string }[]).map(parseEventRow);
  return { run: toRow(raw), events };
}

/** The run row alone — what the stream endpoint checks before replaying. */
export function getRunRow(id: string): RunRow | null {
  const raw = stmts().getRun.get(id) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}

/** Ordered persisted events with seq >= from, for replay-then-subscribe re-attach. */
export function getEventsSince(runId: string, from = 0): RunEventRow[] {
  return (stmts().getEventsSince.all(runId, Math.max(0, Math.floor(from) || 0)) as { seq: number; ts: number; data: string }[]).map(parseEventRow);
}
