import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { aChatSession, anImageSession, aProject } from "@/test/factories";
import { ProjectSwitcher } from "./ProjectSwitcher";
import { renderApp, stubFetch } from "./test-utils";

function props(overrides: Partial<Parameters<typeof ProjectSwitcher>[0]> = {}) {
  return {
    projects: [] as ReturnType<typeof aProject>[],
    sessions: [],
    activeId: null,
    onSelect: () => {},
    onCreate: () => {},
    onRename: () => {},
    onDelete: () => {},
    ...overrides,
  } satisfies Parameters<typeof ProjectSwitcher>[0];
}

describe("ProjectSwitcher", () => {
  it("lists projects with a truthful session summary and selects one", async () => {
    const project = aProject({ title: "Poster shoot" });
    const sessions = [aChatSession({ projectId: project.id }), anImageSession({ projectId: project.id }), anImageSession({ projectId: project.id })];
    const onSelect = vi.fn();
    const user = userEvent.setup();
    stubFetch();
    renderApp(<ProjectSwitcher {...props({ projects: [project], sessions, onSelect })} />);

    await user.click(screen.getByRole("button", { name: /all projects/i }));
    expect(await screen.findByText("1 chat · 2 image sessions")).toBeInTheDocument();
    expect(screen.getByText("Everything, filed and unfiled")).toBeInTheDocument();

    await user.click(screen.getByText("Poster shoot"));
    expect(onSelect).toHaveBeenCalledWith(project.id);
  });

  it("selecting All projects reports null scope", async () => {
    const project = aProject();
    const onSelect = vi.fn();
    const user = userEvent.setup();
    stubFetch();
    renderApp(<ProjectSwitcher {...props({ projects: [project], activeId: project.id, onSelect })} />);

    await user.click(screen.getByRole("button", { name: new RegExp(project.title) }));
    await user.click(await screen.findByText("Everything, filed and unfiled"));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it("renames the active project inline, committing on Enter", async () => {
    const project = aProject({ title: "Old name" });
    const onRename = vi.fn();
    const user = userEvent.setup();
    stubFetch();
    renderApp(<ProjectSwitcher {...props({ projects: [project], activeId: project.id, onRename })} />);

    await user.click(screen.getByRole("button", { name: "Rename project" }));
    const input = screen.getByRole("textbox", { name: "Project title" });
    await user.clear(input);
    await user.type(input, "New name{Enter}");

    expect(onRename).toHaveBeenCalledWith(project.id, "New name");
  });

  it("deleting asks for confirmation and explains that sessions survive", async () => {
    const project = aProject({ title: "Doomed" });
    const onDelete = vi.fn();
    const user = userEvent.setup();
    stubFetch();
    renderApp(<ProjectSwitcher {...props({ projects: [project], onDelete })} />);

    await user.click(screen.getByRole("button", { name: /all projects/i }));
    await user.click(await screen.findByRole("button", { name: "Delete" }));
    expect(onDelete).not.toHaveBeenCalled();
    expect(await screen.findByText("Delete this project?")).toBeInTheDocument();
    expect(screen.getByText(/chats and image sessions are kept/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /^Delete$/ }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith(project.id));
  });
});
