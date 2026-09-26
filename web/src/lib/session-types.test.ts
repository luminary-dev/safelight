import { describe, expect, it } from "vitest";
import { autoTitle, newSession, type ChatSession, type Session } from "./session-types";

describe("autoTitle", () => {
  it("uses the text when short", () => {
    expect(autoTitle("A red bicycle", "fallback")).toBe("A red bicycle");
  });

  it("collapses whitespace", () => {
    expect(autoTitle("  a\n  b\tc  ", "fallback")).toBe("a b c");
  });

  it("falls back on empty text", () => {
    expect(autoTitle("   ", "fallback")).toBe("fallback");
    expect(autoTitle("", "fallback")).toBe("fallback");
  });

  it("truncates long text with an ellipsis at 42 chars", () => {
    const long = "x".repeat(100);
    const title = autoTitle(long, "fallback");
    expect(title.endsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(43);
  });
});

describe("session back-compat", () => {
  // A chat session exactly as sessions.json stored it before system/params/files existed.
  const legacy = JSON.stringify({
    id: "b6f6f5a3-0000-4000-8000-000000000001",
    kind: "chat",
    title: "Old chat",
    titled: false,
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    model: "ollama::llama3.2",
    messages: [
      { role: "user", text: "hi", images: [{ ref: "safelight/a.png", filename: "a.png", subfolder: "safelight" }] },
      { role: "assistant", text: "hello" },
    ],
  });

  it("parses a pre-existing session without the new optional fields", () => {
    const s = JSON.parse(legacy) as Session;
    expect(s.kind).toBe("chat");
    const chat = s as ChatSession;
    expect(chat.system).toBeUndefined();
    expect(chat.params).toBeUndefined();
    expect(chat.messages[0].files).toBeUndefined();
    expect(chat.messages).toHaveLength(2);
  });

  it("round-trips the new optional fields", () => {
    const chat = { ...(JSON.parse(legacy) as ChatSession) };
    chat.system = "Answer in French.";
    chat.params = { temperature: 0.4, topP: 0.9, maxTokens: 2048 };
    chat.messages[0].files = [{ name: "notes.txt", text: "content", truncated: false }];
    const back = JSON.parse(JSON.stringify(chat)) as ChatSession;
    expect(back.system).toBe("Answer in French.");
    expect(back.params).toEqual({ temperature: 0.4, topP: 0.9, maxTokens: 2048 });
    expect(back.messages[0].files?.[0].name).toBe("notes.txt");
  });

  it("newSession still creates chats without tuning set", () => {
    const s = newSession("chat") as ChatSession;
    expect(s.system).toBeUndefined();
    expect(s.params).toBeUndefined();
  });
});
