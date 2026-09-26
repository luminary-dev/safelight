import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsDialog } from "./SettingsDialog";
import { renderApp, stubFetch, type FetchRoute } from "./test-utils";

function baseRoutes(settings: Record<string, number | boolean> = {}): FetchRoute[] {
  return [
    { url: "/api/themes", reply: { themes: [], active: null } },
    { url: "/api/settings", reply: { settings } },
    { url: "/api/usage", reply: { totals: { cost: 1.5, inputTokens: 12000, outputTokens: 3400, images: 7 } } },
    { url: "/api/runs", reply: { runs: [] } },
    { url: "/api/license", reply: { licensed: false } },
  ];
}

const LICENSED = { licensed: true, payload: { v: 1, name: "Alice Example", majorVersion: 1, issued: "2026-09-26" } };

function dialog(overrides: Partial<Parameters<typeof SettingsDialog>[0]> = {}) {
  return <SettingsDialog open onClose={() => {}} onOpenKeys={() => {}} onOpenMcp={() => {}} {...overrides} />;
}

describe("SettingsDialog", () => {
  it("loads the saved spend limits and usage summary", async () => {
    stubFetch(...baseRoutes({ spendLimitDaySoft: 2, spendLimitMonthHard: 50 }));
    renderApp(dialog());

    await waitFor(() => expect(screen.getByLabelText("Daily warning ($)")).toHaveValue("2"));
    expect(screen.getByLabelText("Monthly stop ($)")).toHaveValue("50");
    expect(screen.getByLabelText("Daily stop ($)")).toHaveValue("");
    expect(screen.getByText(/Last 30 days: \$1\.50/)).toBeInTheDocument();
  });

  it("saves the limits as numbers, clears blanks to null, and confirms", async () => {
    const { of } = stubFetch(...baseRoutes({ spendLimitDayHard: 9 }), { method: "PATCH", url: "/api/settings", reply: { ok: true } });
    const user = userEvent.setup();
    renderApp(dialog());
    await waitFor(() => expect(screen.getByLabelText("Daily stop ($)")).toHaveValue("9"));

    await user.type(screen.getByLabelText("Daily warning ($)"), "2.5");
    await user.clear(screen.getByLabelText("Daily stop ($)"));
    await user.click(screen.getByRole("button", { name: "Save limits" }));

    await screen.findByText("Saved.");
    expect(of("PATCH", "/api/settings")[0].body).toEqual({
      spendLimitDaySoft: 2.5,
      spendLimitDayHard: null,
      spendLimitMonthSoft: null,
      spendLimitMonthHard: null,
    });
  });

  it("rejects a non-numeric limit with the field's name and saves nothing", async () => {
    const { of } = stubFetch(...baseRoutes(), { method: "PATCH", url: "/api/settings", reply: { ok: true } });
    const user = userEvent.setup();
    renderApp(dialog());
    await screen.findByRole("button", { name: "Save limits" });

    await user.type(screen.getByLabelText("Monthly warning ($)"), "lots");
    await user.click(screen.getByRole("button", { name: "Save limits" }));

    await screen.findByText("Monthly warning ($) must be a non-negative number.");
    expect(of("PATCH", "/api/settings")).toHaveLength(0);
  });

  it("the Local-only switch round-trips through /api/settings", async () => {
    const { of } = stubFetch(...baseRoutes({ localOnly: true }), { method: "PATCH", url: "/api/settings", reply: { ok: true } });
    const onLocalOnlyChange = vi.fn();
    const user = userEvent.setup();
    renderApp(dialog({ onLocalOnlyChange }));

    // Loaded state is honoured…
    const toggle = screen.getByRole("switch", { name: "Local only" });
    await waitFor(() => expect(toggle).toBeChecked());

    // …and turning it off PATCHes null (delete the key) before flipping the UI.
    await user.click(toggle);
    await waitFor(() => expect(toggle).not.toBeChecked());
    expect(of("PATCH", "/api/settings")[0].body).toEqual({ localOnly: null });
    expect(onLocalOnlyChange).toHaveBeenCalledWith(false);
  });

  it("pins the header and scrolls the sections in an internal body (§6: the body scrolls, never the whole dialog)", async () => {
    stubFetch(...baseRoutes());
    renderApp(dialog());
    const dlg = await screen.findByRole("dialog");
    const card = dlg.querySelector("[class*=card-raised]") as HTMLElement;
    expect(card.className).toContain("max-h-[calc(94dvh-1rem)]");
    expect(card.className).toContain("max-md:max-h-dvh"); // <768 full-height sheet

    // Close lives in the pinned header — its nearest scroller is the overlay backstop…
    const close = screen.getByRole("button", { name: "Close" });
    expect(close.closest(".overflow-y-auto")).toBe(dlg);
    // …while the sections scroll in the internal body region.
    const save = await screen.findByRole("button", { name: "Save limits" });
    expect(save.closest(".overflow-y-auto")).not.toBe(dlg);
    expect(save.closest(".overflow-y-auto")).not.toBeNull();
  });

  it("does not flip Local-only when the save fails", async () => {
    stubFetch(...baseRoutes(), {
      method: "PATCH",
      url: "/api/settings",
      reply: () => {
        throw new Error("offline");
      },
    });
    const user = userEvent.setup();
    renderApp(dialog());
    const toggle = screen.getByRole("switch", { name: "Local only" });
    await waitFor(() => expect(toggle).not.toBeChecked());

    await user.click(toggle);
    expect(toggle).not.toBeChecked();
  });

  it("unlicensed is presented as the normal state, not a nag", async () => {
    stubFetch(...baseRoutes());
    renderApp(dialog());
    await screen.findByText(/Personal use — fully functional/);
    expect(screen.getByRole("button", { name: /Add license file/ })).toBeInTheDocument();
    expect(screen.queryByText(/Licensed to/)).not.toBeInTheDocument();
  });

  it("a licensed install shows who it is licensed to and can remove it", async () => {
    const routes = baseRoutes().filter((r) => r.url !== "/api/license");
    const { of } = stubFetch(
      ...routes,
      { url: "/api/license", reply: LICENSED },
      { method: "DELETE", url: "/api/license", reply: { licensed: false } },
    );
    const user = userEvent.setup();
    renderApp(dialog());

    await screen.findByText("Licensed to Alice Example");
    expect(screen.getByText(/Covers Safelight 1\.x — issued 2026-09-26/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Remove license" }));
    await screen.findByText(/Personal use — fully functional/);
    expect(of("DELETE", "/api/license")).toHaveLength(1);
  });

  it("an invalid license file surfaces the server's reason and stays unlicensed", async () => {
    stubFetch(...baseRoutes(), {
      method: "POST",
      url: "/api/license",
      reply: new Response(JSON.stringify({ error: "The signature does not match — the file was altered or not issued by Luminary." }), {
        status: 400,
        headers: { "content-type": "application/json" },
      }),
    });
    const user = userEvent.setup();
    const { container } = renderApp(dialog());
    await screen.findByText(/Personal use — fully functional/);

    const input = container.querySelector('input[accept="application/json,.json"]') as HTMLInputElement;
    await user.upload(input, new File(["{}"], "license.json", { type: "application/json" }));

    await screen.findByText(/signature does not match/);
    expect(screen.getByText(/Personal use — fully functional/)).toBeInTheDocument();
  });

  it("a genuine license file flips the section to licensed", async () => {
    const { of } = stubFetch(...baseRoutes(), { method: "POST", url: "/api/license", reply: LICENSED });
    const user = userEvent.setup();
    const { container } = renderApp(dialog());
    await screen.findByText(/Personal use — fully functional/);

    const input = container.querySelector('input[accept="application/json,.json"]') as HTMLInputElement;
    await user.upload(input, new File(['{"payload":{},"sig":"x"}'], "license.json", { type: "application/json" }));

    await screen.findByText("Licensed to Alice Example");
    expect((of("POST", "/api/license")[0].body as { license: string }).license).toContain('"sig"');
  });
});
