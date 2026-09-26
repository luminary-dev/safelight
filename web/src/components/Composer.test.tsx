import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ModelCatalog } from "@/lib/comfy/types";
import { SIZE_PRESETS, SIZE_SCALES, scaledSize } from "@/lib/presets";
import { DEFAULT_SETTINGS, defaultsForModel, type Settings } from "@/lib/safelight-state";
import { aModelEntry } from "@/test/factories";
import { Composer } from "./Composer";
import { renderApp, stubFetch, type FetchCall, type FetchRoute } from "./test-utils";

const qwen = aModelEntry(); // qwen-image, unet_gguf
const sdxl = aModelEntry({ family: "sdxl" }); // checkpoints
const CATALOG: ModelCatalog = {
  models: [qwen, sdxl],
  textEncoders: ["qwen_3_vl_7b_bf16.safetensors"],
  vaes: ["qwen_image_vae.safetensors"],
  loras: ["style-lora.safetensors"],
  samplers: ["euler", "dpmpp_2m"],
  schedulers: ["simple", "karras"],
  online: true,
};

/** The debounced swap-guard preflight always POSTs /api/generate; answer it (and let tests override the verdict). */
function preflightRoute(warning: string | null = null): FetchRoute {
  return {
    method: "POST",
    url: "/api/generate",
    reply: (call: FetchCall) => {
      if ((call.body as { preflight?: boolean }).preflight) return { warning };
      throw new Error(`Unexpected non-preflight generate POST: ${JSON.stringify(call.body)}`);
    },
  };
}

function Harness({
  initial,
  online = true,
  onGenerate = () => {},
}: {
  initial?: Partial<Settings>;
  online?: boolean;
  onGenerate?: () => void;
}) {
  const [settings, setSettings] = useState<Settings>({ ...DEFAULT_SETTINGS, model: qwen, ...initial });
  return (
    <Composer
      catalog={CATALOG}
      online={online}
      settings={settings}
      onChange={(patch) => setSettings((prev) => ({ ...prev, ...patch }))}
      onSelectModel={(m) => setSettings((prev) => ({ ...prev, model: m, ...defaultsForModel(m, CATALOG) }))}
      onUpload={async () => {}}
      uploading={false}
      canGenerate
      submitting={false}
      error={null}
      onGenerate={onGenerate}
      onOpenKeys={() => {}}
    />
  );
}

describe("Composer", () => {
  it("aspect and scale pills compute the exact size shown", async () => {
    stubFetch(preflightRoute());
    const user = userEvent.setup();
    renderApp(<Harness />);
    expect(screen.getByText("1024 × 1024")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "16:9" }));
    const wide = SIZE_PRESETS.find((p) => p.id === "landscape-16-9")!;
    expect(screen.getByText(`${wide.width} × ${wide.height}`)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "2 MP" }));
    const scaled = scaledSize(wide, SIZE_SCALES.find((s) => s.id === "2")!.factor);
    expect(screen.getByText(`${scaled.width} × ${scaled.height}`)).toBeInTheDocument();
  });

  it("lock-seed: the seed is only editable while locked, and the footer says which mode is on", async () => {
    stubFetch(preflightRoute());
    const user = userEvent.setup();
    renderApp(<Harness />);
    expect(screen.getByText("random seed")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "More settings" }));
    expect(screen.getByRole("spinbutton", { name: "Seed" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Random" }));
    expect(screen.getByRole("spinbutton", { name: "Seed" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Locked" })).toBeInTheDocument();
    expect(screen.getByText("seed 0")).toBeInTheDocument();
  });

  it("picking another model resets the LoRA to the family default", async () => {
    stubFetch(preflightRoute());
    const user = userEvent.setup();
    renderApp(<Harness initial={{ lora: "style-lora.safetensors" }} />);

    await user.click(screen.getByRole("button", { name: "More settings" }));
    expect(screen.getByText("style-lora.safetensors")).toBeInTheDocument();

    // The trigger carries an aria-label (comboboxes take no name from content — bug fixed with this test).
    const trigger = screen.getByRole("combobox", { name: "Choose a model" });
    expect(within(trigger).getByText(qwen.label)).toBeInTheDocument();
    await user.click(trigger);
    await user.click(await screen.findByText(sdxl.label));

    expect(within(trigger).getByText(sdxl.label)).toBeInTheDocument();
    expect(screen.queryByText("style-lora.safetensors")).not.toBeInTheDocument();
    expect(screen.getByText("None")).toBeInTheDocument();
  });

  it("sweep: value sweeps demand 2–6 numbers before they can queue, then send exactly those values", async () => {
    const generateCalls: FetchCall[] = [];
    stubFetch({
      method: "POST",
      url: "/api/generate",
      reply: (call: FetchCall) => {
        if ((call.body as { preflight?: boolean }).preflight) return { warning: null };
        generateCalls.push(call);
        return {
          group: "sweep-group-1",
          points: [
            { id: "cell-1", seed: 1, value: 5, label: "cfg 5" },
            { id: "cell-2", seed: 1, value: 7, label: "cfg 7" },
          ],
        };
      },
    });
    const user = userEvent.setup();
    renderApp(<Harness />);

    await user.click(screen.getByRole("button", { name: "Sweep" }));
    await user.click(screen.getByRole("combobox", { name: "Sweep type" }));
    await user.click(await screen.findByRole("option", { name: "CFG values" }));

    const values = screen.getByRole("textbox", { name: "Sweep values (comma-separated)" });
    await user.type(values, "5");
    expect(screen.getByText("Enter 2–6 comma-separated values.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /create/i })).toBeDisabled();

    await user.type(values, ", 7");
    const create = screen.getByRole("button", { name: /create 2 variations/i });
    expect(create).toBeEnabled();
    await user.click(create);

    await waitFor(() => expect(generateCalls).toHaveLength(1));
    const body = generateCalls[0].body as { sweep: { kind: string; values: number[] }; prompt: string };
    expect(body.sweep).toEqual({ kind: "cfg", values: [5, 7] });
  });

  it("the memory warning banner renders from the preflight verdict and dismisses", async () => {
    stubFetch(preflightRoute("Qwen-Image plus its text encoder needs ~22 GB; this machine has 26 GB."));
    const user = userEvent.setup();
    renderApp(<Harness />);

    await screen.findByText(/needs ~22 GB/, undefined, { timeout: 2000 });

    await user.click(screen.getByRole("button", { name: "Dismiss memory warning" }));
    expect(screen.queryByText(/needs ~22 GB/)).not.toBeInTheDocument();
  });

  it("tells the user when a local model needs the offline backend", () => {
    stubFetch(preflightRoute());
    renderApp(<Harness online={false} />);
    expect(screen.getByText(/ComfyUI is offline\. Local models need it/)).toBeInTheDocument();
  });

  it("Cmd+Enter in the prompt box generates", async () => {
    stubFetch(preflightRoute());
    const onGenerate = vi.fn();
    const user = userEvent.setup();
    renderApp(<Harness onGenerate={onGenerate} />);

    await user.type(screen.getByPlaceholderText("Describe what you want to see"), "a lighthouse");
    await user.keyboard("{Meta>}{Enter}{/Meta}");

    expect(onGenerate).toHaveBeenCalledTimes(1);
  });
});
