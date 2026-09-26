import { describe, expect, it } from "vitest";
import { foldFiles, toTurns } from "./chat-images";

describe("foldFiles", () => {
  it("returns the content untouched without files", () => {
    expect(foldFiles("hello")).toBe("hello");
    expect(foldFiles("hello", [])).toBe("hello");
  });

  it("prepends a labeled fenced block per file", () => {
    const out = foldFiles("summarize this", [{ name: "notes.txt", text: "line one" }]);
    expect(out).toBe("[Attached: notes.txt]\n```\nline one\n```\n\nsummarize this");
  });

  it("stands alone when the message has no text", () => {
    const out = foldFiles("", [{ name: "a.csv", text: "x,y" }]);
    expect(out).toBe("[Attached: a.csv]\n```\nx,y\n```");
  });

  it("skips malformed entries", () => {
    const out = foldFiles("q", [{ name: "empty.txt", text: "  " }, { name: "ok.md", text: "body" }]);
    expect(out).toBe("[Attached: ok.md]\n```\nbody\n```\n\nq");
  });
});

describe("toTurns with files", () => {
  it("folds user file attachments into the turn content", async () => {
    const turns = await toTurns([
      { role: "user", content: "what does this say?", files: [{ name: "doc.txt", text: "the payload" }] },
      { role: "assistant", content: "…" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].content).toContain("[Attached: doc.txt]");
    expect(turns[0].content).toContain("the payload");
    expect(turns[0].content.endsWith("what does this say?")).toBe(true);
  });

  it("keeps a files-only message that has no text", async () => {
    const turns = await toTurns([{ role: "user", content: "", files: [{ name: "doc.txt", text: "content" }] }]);
    expect(turns).toHaveLength(1);
    expect(turns[0].content).toContain("content");
  });
});
