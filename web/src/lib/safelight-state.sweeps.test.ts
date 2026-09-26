import { beforeEach, describe, expect, it, vi } from "vitest";
import { addSweepGroup, getSweepGroups, patchSweepCell, removeSweepGroup, subscribeSweeps, type SweepGroupState } from "./safelight-state";

function group(id: string, cells = 2): SweepGroupState {
  return {
    group: id,
    kind: "seed",
    prompt: "a bird",
    width: 512,
    height: 512,
    startedAt: 1,
    cells: Array.from({ length: cells }, (_, i) => ({ id: `${id}-job-${i}`, seed: i, value: i, label: `seed ${i}`, state: "queued" as const, outputs: [] })),
  };
}

beforeEach(() => {
  for (const g of [...getSweepGroups()]) removeSweepGroup(g.group);
});

describe("sweep store", () => {
  it("adds groups newest-first and notifies subscribers", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeSweeps(listener);
    addSweepGroup(group("g1"));
    addSweepGroup(group("g2"));
    expect(getSweepGroups().map((g) => g.group)).toEqual(["g2", "g1"]);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    addSweepGroup(group("g3"));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("patches one cell immutably and leaves the rest alone", () => {
    addSweepGroup(group("g1"));
    const before = getSweepGroups();
    patchSweepCell("g1", "g1-job-1", { state: "done", outputs: [{ filename: "x.png", subfolder: "s", type: "output" }] });
    const after = getSweepGroups();
    expect(after).not.toBe(before);
    const cells = after.find((g) => g.group === "g1")!.cells;
    expect(cells[1].state).toBe("done");
    expect(cells[1].outputs).toHaveLength(1);
    expect(cells[0].state).toBe("queued");
  });

  it("ignores patches for unknown groups or cells without emitting", () => {
    addSweepGroup(group("g1"));
    const listener = vi.fn();
    const unsubscribe = subscribeSweeps(listener);
    const snapshot = getSweepGroups();
    patchSweepCell("nope", "g1-job-0", { state: "done" });
    patchSweepCell("g1", "nope", { state: "done" });
    expect(getSweepGroups()).toBe(snapshot);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("removes a group and caps the list at 12", () => {
    for (let i = 0; i < 15; i += 1) addSweepGroup(group(`g${i}`));
    expect(getSweepGroups()).toHaveLength(12);
    removeSweepGroup("g14");
    expect(getSweepGroups().some((g) => g.group === "g14")).toBe(false);
    const snapshot = getSweepGroups();
    removeSweepGroup("g14"); // already gone: no change, no emit
    expect(getSweepGroups()).toBe(snapshot);
  });
});
