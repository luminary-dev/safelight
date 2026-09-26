import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ProgressState } from "@/hooks/useComfySocket";
import { aJob } from "@/test/factories";
import { liveStage, RunQueue, type QueueEntry } from "./RunQueue";
import { renderApp, stubFetch } from "./test-utils";

function progress(overrides: Partial<ProgressState> = {}): ProgressState {
  return { connected: true, activePromptId: null, progress: 0, step: 0, totalSteps: 0, nodeLabel: null, queueRemaining: 0, preview: null, ...overrides };
}

const entry = (job: QueueEntry["job"], sessionTitle = "Session"): QueueEntry => ({ job, sessionTitle });

/** The row that contains this job's prompt text. */
function rowFor(prompt: string): HTMLElement {
  return screen.getByTitle(prompt).closest("div.develop") as HTMLElement;
}

describe("liveStage", () => {
  it("reports honest labels for inactive jobs", () => {
    expect(liveStage(aJob({ state: "queued" }), progress())).toEqual({ label: "Queued", pct: null });
    expect(liveStage(aJob({ state: "running" }), progress())).toEqual({ label: "Rendering", pct: null });
  });

  it("reports sampling steps for the active job on a KSampler node", () => {
    const job = aJob({ id: "p1", state: "running", nodes: { "3": "KSampler" } });
    const p = progress({ activePromptId: "p1", nodeLabel: "3", step: 5, totalSteps: 20, progress: 0.25 });
    expect(liveStage(job, p)).toEqual({ label: "Step 5 of 20", pct: 25 });
  });

  it("says Starting before the first node reports", () => {
    const job = aJob({ id: "p1", state: "running" });
    expect(liveStage(job, progress({ activePromptId: "p1" }))).toEqual({ label: "Starting", pct: null });
  });
});

describe("RunQueue", () => {
  it("shows every entry with its truthful state", () => {
    stubFetch();
    const running = aJob({ id: "p-run", state: "running", prompt: "the running one", nodes: { "3": "KSampler" } });
    const waiting = aJob({ id: "p-wait", state: "queued", prompt: "the waiting one" });
    renderApp(<RunQueue queue={[entry(running), entry(waiting)]} progress={progress({ activePromptId: "p-run", nodeLabel: "3", step: 7, totalSteps: 20, progress: 0.35 })} />);

    expect(screen.getByText(/Rendering queue/)).toHaveTextContent("Rendering queue 2");
    expect(within(rowFor("the running one")).getByText("Step 7 of 20")).toBeInTheDocument();
    expect(within(rowFor("the waiting one")).getByText("queued")).toBeInTheDocument();
  });

  it("the stage label truncates with its full value in a title (§7: every row is a truncation case)", () => {
    stubFetch();
    const running = aJob({ id: "p-run", state: "running", prompt: "the running one", nodes: { "3": "KSampler" } });
    const waiting = aJob({ id: "p-wait", state: "queued", prompt: "the waiting one" });
    renderApp(<RunQueue queue={[entry(running), entry(waiting)]} progress={progress({ activePromptId: "p-run", nodeLabel: "3", step: 7, totalSteps: 20, progress: 0.35 })} />);

    expect(within(rowFor("the running one")).getByTitle("Step 7 of 20")).toBeInTheDocument();
    expect(within(rowFor("the waiting one")).getByTitle("queued")).toBeInTheDocument();
  });

  it("Cancel deletes the job on the server", async () => {
    const { of } = stubFetch({ method: "DELETE", url: /\/api\/jobs\/.+/, reply: { ok: true } });
    const job = aJob({ id: "p-run", state: "running", prompt: "cancel me" });
    const user = userEvent.setup();
    renderApp(<RunQueue queue={[entry(job)]} progress={progress({ activePromptId: "p-run" })} />);

    await user.click(within(rowFor("cancel me")).getByRole("button", { name: "Cancel render" }));

    expect(of("DELETE", "/api/jobs/p-run")).toHaveLength(1);
  });

  it("Run next moves a waiting render to the front", async () => {
    const { of } = stubFetch({ method: "POST", url: /\/api\/jobs\/.+/, reply: { ok: true } });
    const waiting = aJob({ id: "p-wait", state: "queued", prompt: "queue jumper" });
    const user = userEvent.setup();
    renderApp(<RunQueue queue={[entry(waiting)]} progress={progress()} />);

    await user.click(within(rowFor("queue jumper")).getByRole("button", { name: "Run next" }));

    const posts = of("POST", "/api/jobs/p-wait");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ action: "front" });
  });

  it("Clear queued empties the waiting queue in one call", async () => {
    const { of } = stubFetch({ method: "DELETE", url: "/api/jobs", reply: { ok: true } });
    const user = userEvent.setup();
    renderApp(<RunQueue queue={[entry(aJob({ state: "queued" })), entry(aJob({ state: "queued" }))]} progress={progress()} />);

    await user.click(screen.getByRole("button", { name: "Clear queued" }));

    expect(of("DELETE", "/api/jobs")).toHaveLength(1);
  });

  it("browser-only and cloud jobs offer no queue controls, and Clear queued hides without waiters", () => {
    stubFetch();
    const pending = aJob({ id: "pending-abc", state: "queued", prompt: "not yet queued" });
    const cloud = aJob({ id: "cloud-abc", state: "running", prompt: "cloud render" });
    renderApp(<RunQueue queue={[entry(pending), entry(cloud)]} progress={progress()} />);

    expect(screen.queryByRole("button", { name: "Cancel render" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run next" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Clear queued" })).not.toBeInTheDocument();
  });
});
