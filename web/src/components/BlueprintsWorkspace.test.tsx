import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { BlueprintListEntry, BlueprintListResponse } from "@/lib/blueprints/types";
import { aBlueprint } from "@/test/factories";
import { BlueprintsWorkspace } from "./BlueprintsWorkspace";
import { json, renderApp, stubFetch, type FetchRoute } from "./test-utils";

function entry(overrides: Partial<BlueprintListEntry> = {}): BlueprintListEntry {
  return { ...aBlueprint(), status: "ready", missingModels: [], missingNodeClasses: [], ...overrides };
}

function catalogRoute(blueprints: BlueprintListEntry[], online = true): FetchRoute {
  const body: BlueprintListResponse = { online, blueprints, failures: [] };
  return { url: "/api/blueprints", reply: body };
}

const upscale = () => entry({ id: "bp-upscale", name: "Upscale Photo", category: "image" });
const depth = () =>
  entry({ id: "bp-depth", name: "Depth Estimation", category: "image", status: "missing", missingModels: ["depth_anything_v2.safetensors"] });
const strip = () => entry({ id: "bp-strip", name: "Strip Metadata", category: "utility" });

describe("BlueprintsWorkspace", () => {
  it("groups the catalog by category with truthful status chips, ready first", async () => {
    stubFetch(catalogRoute([depth(), strip(), upscale()]));
    renderApp(<BlueprintsWorkspace />);

    await screen.findByText("Upscale Photo");
    expect(screen.getByRole("status")).toHaveTextContent("3 workflows from the render engine · 2 ready on this machine");

    expect(screen.getByRole("heading", { name: "Image" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Utilities" })).toBeInTheDocument();

    const imageSection = screen.getByRole("heading", { name: "Image" }).closest("section")!;
    const cards = within(imageSection).getAllByRole("button");
    expect(cards[0]).toHaveTextContent("Upscale Photo"); // ready sorts before missing
    expect(cards[0]).toHaveTextContent("Ready");
    expect(cards[1]).toHaveTextContent("Depth Estimation");
    expect(cards[1]).toHaveTextContent("Needs 1");
    expect(cards[1]).toHaveTextContent("missing: depth_anything_v2.safetensors");
  });

  it("search and category pills filter the catalog", async () => {
    stubFetch(catalogRoute([upscale(), depth(), strip()]));
    const user = userEvent.setup();
    renderApp(<BlueprintsWorkspace />);
    await screen.findByText("Upscale Photo");

    await user.type(screen.getByRole("textbox", { name: "Search blueprints" }), "depth");
    expect(screen.getByText("Depth Estimation")).toBeInTheDocument();
    expect(screen.queryByText("Upscale Photo")).not.toBeInTheDocument();

    await user.clear(screen.getByRole("textbox", { name: "Search blueprints" }));
    await user.click(screen.getByRole("button", { name: "Utilities", pressed: false }));
    expect(screen.getByText("Strip Metadata")).toBeInTheDocument();
    expect(screen.queryByText("Depth Estimation")).not.toBeInTheDocument();

    await user.type(screen.getByRole("textbox", { name: "Search blueprints" }), "zzz");
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("card text truncates accessibly: names and metadata always expose their full value (§5.14, §7)", async () => {
    const longName = `An Extremely Verbose Blueprint Title ${"Very ".repeat(30)}Long`;
    stubFetch(catalogRoute([entry({ id: "bp-long", name: longName, category: "image" }), depth()]));
    renderApp(<BlueprintsWorkspace />);

    const name = await screen.findByText(longName);
    expect(name).toHaveAttribute("title", longName);
    // A missing card's metadata line carries the full missing list as its title.
    const card = screen.getByText("Depth Estimation").closest("button")!;
    expect(within(card).getByText(/missing: depth_anything_v2\.safetensors/)).toHaveAttribute("title", "depth_anything_v2.safetensors");
  });

  it("shows the server's error when the registry fails to load", async () => {
    stubFetch({ url: "/api/blueprints", reply: () => json({ error: "The registry burned down." }, 500) });
    renderApp(<BlueprintsWorkspace />);
    await screen.findByText("The registry burned down.");
  });

  it("notes when readiness is unknown because ComfyUI is offline", async () => {
    stubFetch(catalogRoute([upscale()], false));
    renderApp(<BlueprintsWorkspace />);
    await screen.findByText(/ComfyUI is offline, readiness unknown/);
  });

  it("opens a card into its runner and comes back", async () => {
    const bp = upscale();
    stubFetch(catalogRoute([bp]), { url: `/api/blueprints/${bp.id}`, reply: { ...bp, online: true } });
    const user = userEvent.setup();
    renderApp(<BlueprintsWorkspace />);

    await user.click(await screen.findByText("Upscale Photo"));
    expect(await screen.findByRole("button", { name: /run blueprint/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Upscale Photo", level: 1 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /all blueprints/i }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "Blueprints" })).toBeInTheDocument());
  });
});
