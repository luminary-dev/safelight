import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { McpDialog } from "./McpDialog";
import { renderApp, stubFetch, type FetchRoute } from "./test-utils";

interface ServerFixture {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  url?: string;
  enabled: boolean;
  status: "ok" | "error" | "off";
  tools: { name: string; description: string; readOnly: boolean }[];
  error?: string;
}

const filesystem: ServerFixture = {
  id: "mcp-1",
  name: "Filesystem",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
  enabled: true,
  status: "ok",
  tools: [
    { name: "read_file", description: "Read a file", readOnly: true },
    { name: "write_file", description: "Write a file", readOnly: false },
  ],
};

const broken: ServerFixture = { id: "mcp-2", name: "Flaky", transport: "http", url: "https://mcp.example/mcp", enabled: false, status: "error", tools: [], error: "connect ECONNREFUSED" };

const listRoute = (servers: ServerFixture[]): FetchRoute => ({ url: "/api/mcp", reply: { servers } });

describe("McpDialog", () => {
  it("lists servers with status, command line, tools, and the mutation marker", async () => {
    stubFetch(listRoute([filesystem, broken]));
    renderApp(<McpDialog open onClose={() => {}} />);

    await screen.findByText("Filesystem");
    expect(screen.getByText("npx -y @modelcontextprotocol/server-filesystem /tmp")).toBeInTheDocument();
    expect(screen.getByRole("switch", { name: "Filesystem enabled" })).toBeChecked();
    expect(screen.getByRole("switch", { name: "Flaky enabled" })).not.toBeChecked();
    expect(screen.getByText("read_file")).toHaveTextContent(/^read_file$/); // read-only: no marker
    expect(screen.getByText(/write_file/)).toHaveTextContent("write_file ✳"); // mutating: marked
    expect(screen.getByText("connect ECONNREFUSED")).toBeInTheDocument();
  });

  it("the add flow validates and posts a stdio server", async () => {
    const { of } = stubFetch(listRoute([]), { method: "POST", url: "/api/mcp", reply: { ok: true } });
    const user = userEvent.setup();
    renderApp(<McpDialog open onClose={() => {}} />);
    await screen.findByText(/No servers yet/);

    await user.click(screen.getByRole("button", { name: /add server/i }));
    const submit = screen.getByRole("button", { name: /add server/i });
    expect(submit).toBeDisabled(); // nothing filled in yet

    await user.type(screen.getByPlaceholderText("Name, e.g. Filesystem"), "Files");
    expect(submit).toBeDisabled(); // still no command
    await user.type(screen.getByPlaceholderText(/npx -y @modelcontextprotocol/), "npx -y server-fs /tmp");
    await user.click(submit);

    await waitFor(() => expect(of("POST", "/api/mcp")).toHaveLength(1));
    expect(of("POST", "/api/mcp")[0].body).toEqual({ name: "Files", transport: "stdio", command: "npx", args: ["-y", "server-fs", "/tmp"] });
    expect(of("GET", "/api/mcp").length).toBeGreaterThan(1); // reloaded after saving
  });

  it("toggle flips enabled over PATCH and remove deletes by id", async () => {
    const { of } = stubFetch(listRoute([filesystem]), { method: "PATCH", url: "/api/mcp", reply: { ok: true } }, { method: "DELETE", url: "/api/mcp", reply: { ok: true } });
    const user = userEvent.setup();
    renderApp(<McpDialog open onClose={() => {}} />);

    await user.click(await screen.findByRole("switch", { name: "Filesystem enabled" }));
    await waitFor(() => expect(of("PATCH", "/api/mcp")).toHaveLength(1));
    expect(of("PATCH", "/api/mcp")[0].body).toEqual({ id: "mcp-1", enabled: false });

    await user.click(screen.getByRole("button", { name: "Remove Filesystem" }));
    await waitFor(() => expect(of("DELETE", /\/api\/mcp\?id=mcp-1/)).toHaveLength(1));
  });

  it("reports when the server list cannot load", async () => {
    stubFetch({
      url: "/api/mcp",
      reply: () => {
        throw new Error("network down");
      },
    });
    renderApp(<McpDialog open onClose={() => {}} />);
    expect(await screen.findByText("Could not load MCP servers.")).toBeInTheDocument();
  });
});
