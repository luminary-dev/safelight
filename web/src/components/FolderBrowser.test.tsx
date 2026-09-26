import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FolderBrowser } from "./FolderBrowser";
import { renderApp, stubFetch, type FetchCall } from "./test-utils";

interface Listing {
  path: string;
  parent: string | null;
  home: string;
  dirs: { name: string; path: string }[];
}

const HOME: Listing = { path: "/Users/me", parent: "/Users", home: "/Users/me", dirs: [{ name: "code", path: "/Users/me/code" }] };
const CODE: Listing = { path: "/Users/me/code", parent: "/Users/me", home: "/Users/me", dirs: [] };

function browseRoute() {
  return {
    url: /\/api\/code\/browse/,
    reply: (call: FetchCall) => {
      const path = new URL(call.url, "http://localhost").searchParams.get("path");
      if (!path) return HOME;
      if (path === "/Users/me/code") return CODE;
      if (path === "/Users/me") return HOME;
      throw new Error(`No listing for ${path}`);
    },
  };
}

describe("FolderBrowser", () => {
  it("browses into a folder, back up, and picks the current path", async () => {
    stubFetch(browseRoute());
    const onPick = vi.fn();
    const user = userEvent.setup();
    renderApp(<FolderBrowser onPick={onPick} />);

    await user.click(screen.getByRole("button", { name: "Browse for a folder" }));
    expect(await screen.findByText("/Users/me")).toBeInTheDocument();

    await user.click(screen.getByText("code"));
    expect(await screen.findByText("/Users/me/code")).toBeInTheDocument();
    expect(screen.getByText("No subfolders here.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Up one folder" }));
    expect(await screen.findByText("/Users/me")).toBeInTheDocument();

    await user.click(screen.getByText("code"));
    await screen.findByText("/Users/me/code");
    await user.click(screen.getByRole("button", { name: "Use this folder" }));
    expect(onPick).toHaveBeenCalledWith("/Users/me/code");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use this folder" })).not.toBeInTheDocument()); // popover closed
  });

  it("says when a folder cannot be opened", async () => {
    stubFetch({
      url: /\/api\/code\/browse/,
      reply: () => {
        throw new Error("EACCES");
      },
    });
    const user = userEvent.setup();
    renderApp(<FolderBrowser onPick={() => {}} />);

    await user.click(screen.getByRole("button", { name: "Browse for a folder" }));
    expect(await screen.findByText("That folder cannot be opened.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use this folder" })).toBeDisabled();
  });
});
