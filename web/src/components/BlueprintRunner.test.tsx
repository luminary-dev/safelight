import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { BlueprintInput, BlueprintListEntry } from "@/lib/blueprints/types";
import { aBlueprint } from "@/test/factories";
import { BlueprintRunner } from "./BlueprintRunner";
import { json, renderApp, stubFetch, type FetchRoute } from "./test-utils";

type Spec = BlueprintListEntry & { online: boolean };

const promptInput: BlueprintInput = { key: "prompt", label: "Prompt", kind: "prompt", valueType: "STRING", default: "", required: true, targets: [] };
const negativeInput: BlueprintInput = { key: "negative", label: "Negative", kind: "negative-prompt", valueType: "STRING", default: "", required: false, targets: [] };
const imageInput: BlueprintInput = { key: "photo", label: "Photo", kind: "image", valueType: "IMAGE", required: true, targets: [] };
const seedInput: BlueprintInput = { key: "seed", label: "Seed", kind: "number", valueType: "INT", default: 0, required: false, seed: true, targets: [] };
const stepsInput: BlueprintInput = { key: "steps", label: "Steps", kind: "number", valueType: "INT", default: 20, required: false, targets: [] };

function spec(overrides: Partial<Spec> = {}): Spec {
  return { ...aBlueprint({ id: "bp-1", name: "Photo Restyle" }), status: "ready", missingModels: [], missingNodeClasses: [], online: true, inputs: [promptInput], ...overrides };
}

const specRoute = (s: Spec): FetchRoute => ({ url: `/api/blueprints/${s.id}`, reply: s });

describe("BlueprintRunner", () => {
  it("renders one field per input kind: prompts, media slot, and numbers with honest placeholders", async () => {
    stubFetch(specRoute(spec({ inputs: [promptInput, negativeInput, imageInput, seedInput, stepsInput] })));
    renderApp(<BlueprintRunner id="bp-1" />);

    expect(await screen.findByRole("textbox", { name: "Prompt" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Negative" })).toHaveAttribute("placeholder", "What to avoid");
    expect(screen.getByText("Add a image")).toBeInTheDocument();
    expect(screen.getByRole("spinbutton", { name: "Seed" })).toHaveAttribute("placeholder", "random");
    expect(screen.getByRole("spinbutton", { name: "Steps" })).toHaveValue(20);
  });

  it("requires the mandatory media before it will run, then queues with the uploaded ref", async () => {
    const { of } = stubFetch(
      specRoute(spec({ inputs: [promptInput, imageInput] })),
      { method: "POST", url: "/api/upload", reply: { files: [{ ref: "safelight/photo.png", filename: "photo.png", subfolder: "safelight", type: "input" }] } },
      { method: "POST", url: "/api/blueprints/bp-1/run", reply: { id: "bp-job-12345678" } },
    );
    const onQueued = vi.fn();
    const user = userEvent.setup();
    renderApp(<BlueprintRunner id="bp-1" onQueued={onQueued} />);

    const run = await screen.findByRole("button", { name: "Run blueprint" });
    expect(run).toBeDisabled(); // the required photo is missing

    const fileInput = screen.getByText("Add a image").closest("label")!.querySelector("input")!;
    await user.upload(fileInput, new File(["img"], "photo.png", { type: "image/png" }));
    await screen.findByText("photo.png");
    expect(run).toBeEnabled();

    await user.type(screen.getByRole("textbox", { name: "Prompt" }), "make it autumn");
    await user.click(run);

    await waitFor(() => expect(onQueued).toHaveBeenCalledWith("bp-job-12345678"));
    const posts = of("POST", "/api/blueprints/bp-1/run");
    expect(posts).toHaveLength(1);
    expect(posts[0].body).toEqual({ values: { prompt: "make it autumn", photo: "safelight/photo.png" } });
    expect(screen.getByRole("status")).toHaveTextContent("queued");
  });

  it("removing the uploaded media disables the run again", async () => {
    stubFetch(
      specRoute(spec({ inputs: [imageInput] })),
      { method: "POST", url: "/api/upload", reply: { files: [{ ref: "safelight/photo.png", filename: "photo.png", subfolder: "safelight", type: "input" }] } },
    );
    const user = userEvent.setup();
    renderApp(<BlueprintRunner id="bp-1" />);

    const run = await screen.findByRole("button", { name: "Run blueprint" });
    const fileInput = screen.getByText("Add a image").closest("label")!.querySelector("input")!;
    await user.upload(fileInput, new File(["img"], "photo.png", { type: "image/png" }));
    await waitFor(() => expect(run).toBeEnabled());

    await user.click(screen.getByRole("button", { name: "Remove Photo" }));
    expect(run).toBeDisabled();
    expect(screen.getByText("Add a image")).toBeInTheDocument();
  });

  it("the widest form stays usable when narrow: number fields stack below sm and filenames stay accessible (§5.14)", async () => {
    const many: BlueprintInput[] = [seedInput, stepsInput, { key: "cfg", label: "CFG", kind: "number", valueType: "FLOAT", default: 4, required: false, targets: [] }];
    stubFetch(
      specRoute(spec({ name: `Blueprint With A ${"Very ".repeat(40)}Long Name`, inputs: [promptInput, imageInput, ...many] })),
      { method: "POST", url: "/api/upload", reply: { files: [{ ref: "safelight/very-long.png", filename: `${"long-".repeat(40)}photo.png`, subfolder: "safelight", type: "input" }] } },
    );
    const user = userEvent.setup();
    renderApp(<BlueprintRunner id="bp-1" />);

    // The long blueprint name truncates with its full value exposed.
    const heading = await screen.findByRole("heading", { level: 2 });
    expect(heading).toHaveAttribute("title", `Blueprint With A ${"Very ".repeat(40)}Long Name`);

    // Number fields live in a grid that is one column below sm, two from sm up.
    const numberGrid = screen.getByRole("spinbutton", { name: "Seed" }).closest(".grid")!;
    expect(numberGrid.className).toContain("grid-cols-1");
    expect(numberGrid.className).toContain("sm:grid-cols-2");

    // The uploaded media row wraps rather than clipping, and the name carries a title.
    const fileInput = screen.getByText("Add a image").closest("label")!.querySelector("input")!;
    await user.upload(fileInput, new File(["img"], `${"long-".repeat(40)}photo.png`, { type: "image/png" }));
    const name = await screen.findByText(`${"long-".repeat(40)}photo.png`);
    expect(name).toHaveAttribute("title", `${"long-".repeat(40)}photo.png`);
    expect(name.closest("div")!.className).toContain("flex-wrap");
  });

  it("lists exactly what is missing and refuses to run", async () => {
    stubFetch(
      specRoute(
        spec({
          status: "missing",
          missingModels: ["sd_xl_base_1.0.safetensors"],
          missingNodeClasses: ["DepthAnythingPreprocessor"],
        }),
      ),
    );
    renderApp(<BlueprintRunner id="bp-1" />);

    expect(await screen.findByText("Missing models")).toBeInTheDocument();
    expect(screen.getByText("sd_xl_base_1.0.safetensors")).toBeInTheDocument();
    expect(screen.getByText("Missing node classes")).toBeInTheDocument();
    expect(screen.getByText("DepthAnythingPreprocessor")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Missing requirements" })).toBeDisabled();
  });

  it("surfaces the server's queue error", async () => {
    stubFetch(specRoute(spec()), { method: "POST", url: "/api/blueprints/bp-1/run", reply: () => json({ error: "No free VRAM." }, 500) });
    const user = userEvent.setup();
    renderApp(<BlueprintRunner id="bp-1" />);

    await user.click(await screen.findByRole("button", { name: "Run blueprint" }));

    expect(await screen.findByText("No free VRAM.")).toBeInTheDocument();
  });

  it("shows the load failure instead of a form", async () => {
    stubFetch({ url: "/api/blueprints/bp-1", reply: () => json({ error: "Unknown blueprint." }, 404) });
    renderApp(<BlueprintRunner id="bp-1" />);
    expect(await screen.findByText("Unknown blueprint.")).toBeInTheDocument();
  });
});
