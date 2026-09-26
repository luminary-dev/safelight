import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stubFetch } from "@/components/test-utils";
import { aChatSession, aJob, anImageSession, aProject } from "@/test/factories";
import type { ChatSession, ImageSession, Session } from "@/lib/session-types";
import { useSessions } from "./useSessions";

const ACTIVE_KEY = "safelight.active.v1";

/** Drains the microtask chain of the mount-time load (fetch → json → setState). */
async function flushAsync() {
  for (let i = 0; i < 8; i++) await act(async () => {});
}

function stubSessionApi(sessions: Session[] = [], projects: ReturnType<typeof aProject>[] = []) {
  return stubFetch(
    { url: "/api/sessions", reply: { sessions, projects } },
    { method: "POST", url: "/api/sessions", reply: { ok: true } },
    { method: "PATCH", url: /\/api\/sessions\/.+/, reply: { ok: true } },
    { method: "POST", url: "/api/projects", reply: { ok: true } },
    { method: "DELETE", url: /\/api\/projects\/.+/, reply: { ok: true } },
  );
}

describe("useSessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("loads sessions and projects from the server on mount", async () => {
    const chat = aChatSession();
    const image = anImageSession();
    const project = aProject();
    stubSessionApi([chat, image], [project]);

    const { result } = renderHook(() => useSessions());
    expect(result.current.sessionsLoaded).toBe(false);
    await flushAsync();

    expect(result.current.sessionsLoaded).toBe(true);
    expect(result.current.sessions.map((s) => s.id)).toEqual([chat.id, image.id]);
    expect(result.current.projects).toEqual([project]);
    expect(result.current.activeChat?.id).toBe(chat.id);
    expect(result.current.activeImage?.id).toBe(image.id);
  });

  it("falls back to the first session of a kind when the active id no longer exists", async () => {
    const chatA = aChatSession();
    const chatB = aChatSession();
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ chat: "chat-deleted-elsewhere", image: null, code: null, design: null }));
    stubSessionApi([chatA, chatB]);

    const { result } = renderHook(() => useSessions());
    await flushAsync();

    expect(result.current.activeChat?.id).toBe(chatA.id);
  });

  it("scopes the active session to the current project and falls back within it", async () => {
    const project = aProject();
    const filed = aChatSession({ projectId: project.id });
    const unfiled = aChatSession();
    localStorage.setItem(ACTIVE_KEY, JSON.stringify({ chat: unfiled.id, image: null, code: null, design: null }));
    stubSessionApi([filed, unfiled], [project]);

    const { result } = renderHook(() => useSessions());
    await flushAsync();
    expect(result.current.activeChat?.id).toBe(unfiled.id);

    act(() => result.current.setActiveProjectId(project.id));
    expect(result.current.activeChat?.id).toBe(filed.id);
    expect(result.current.byKind.chat.map((s) => s.id)).toEqual([filed.id]);
  });

  it("ensureSession creates one session per kind, filed in the active project, and reuses it", async () => {
    const { of } = stubSessionApi();
    const { result } = renderHook(() => useSessions());
    await flushAsync();

    act(() => result.current.setActiveProjectId("project-9"));
    let first: Session | undefined;
    act(() => {
      first = result.current.ensureSession("image");
    });
    expect(first?.kind).toBe("image");
    expect(first?.projectId).toBe("project-9");
    expect(result.current.activeIds.image).toBe(first?.id);
    const posts = of("POST", "/api/sessions");
    expect(posts).toHaveLength(1);
    expect((posts[0].body as Session).id).toBe(first?.id);

    let second: Session | undefined;
    act(() => {
      second = result.current.ensureSession("image");
    });
    expect(second?.id).toBe(first?.id);
    expect(of("POST", "/api/sessions")).toHaveLength(1);
  });

  it("debounces persistence: two quick renames become one PATCH with the last state", async () => {
    const chat = aChatSession();
    const { of } = stubSessionApi([chat]);
    const { result } = renderHook(() => useSessions());
    await flushAsync();

    act(() => result.current.renameSession(chat.id, "First draft"));
    act(() => result.current.renameSession(chat.id, "Final title"));
    act(() => vi.advanceTimersByTime(599));
    expect(of("PATCH", `/api/sessions/${chat.id}`)).toHaveLength(0);

    act(() => vi.advanceTimersByTime(1));
    const patches = of("PATCH", `/api/sessions/${chat.id}`);
    expect(patches).toHaveLength(1);
    expect((patches[0].body as ChatSession).title).toBe("Final title");
    expect((patches[0].body as ChatSession).titled).toBe(true);
  });

  it("updateJob reaches a job in a non-active session and persists only its holder", async () => {
    const jobA = aJob({ state: "running" });
    const jobB = aJob({ state: "running" });
    const holderA = anImageSession({ jobs: [jobA] });
    const holderB = anImageSession({ jobs: [jobB] });
    const { of } = stubSessionApi([holderA, holderB]);
    const { result } = renderHook(() => useSessions());
    await flushAsync();

    act(() => result.current.updateJob(jobB.id, (j) => ({ ...j, state: "done" })));
    const sessions = result.current.sessions as ImageSession[];
    expect(sessions.find((s) => s.id === holderB.id)?.jobs[0].state).toBe("done");
    expect(sessions.find((s) => s.id === holderA.id)?.jobs[0].state).toBe("running");

    act(() => vi.advanceTimersByTime(600));
    expect(of("PATCH", `/api/sessions/${holderB.id}`)).toHaveLength(1);
    expect(of("PATCH", `/api/sessions/${holderA.id}`)).toHaveLength(0);
  });

  it("removeProject unfiles its sessions and clears the active project", async () => {
    const project = aProject();
    const filed = aChatSession({ projectId: project.id });
    const { of } = stubSessionApi([filed], [project]);
    const { result } = renderHook(() => useSessions());
    await flushAsync();

    act(() => result.current.setActiveProjectId(project.id));
    act(() => result.current.removeProject(project.id));

    expect(result.current.projects).toEqual([]);
    expect(result.current.activeProjectId).toBeNull();
    expect(result.current.sessions[0].projectId).toBeUndefined();
    expect(of("DELETE", `/api/projects/${project.id}`)).toHaveLength(1);
    // The unfiled session is still visible in the all-projects scope.
    expect(result.current.activeChat?.id).toBe(filed.id);
  });
});
