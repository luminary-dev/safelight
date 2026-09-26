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
  ];
}

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
});
