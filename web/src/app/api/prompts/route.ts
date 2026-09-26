import type { NextRequest } from "next/server";
import { deletePrompt, listPrompts, upsertPrompt, type PromptInput } from "@/lib/prompts";

/** GET: saved prompts, newest first. `?q=` filters by title or tag. */
export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get("q") ?? undefined;
    return Response.json({ prompts: listPrompts(q) });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to list prompts." }, { status: 500 });
  }
}

/** POST: upsert one saved prompt ({ id?, title, text, negative?, tags? }). */
export async function POST(request: NextRequest) {
  let body: PromptInput;
  try {
    body = (await request.json()) as PromptInput;
  } catch {
    return Response.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  try {
    return Response.json({ prompt: upsertPrompt(body) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to save the prompt.";
    return Response.json({ error: message }, { status: /needs/i.test(message) ? 400 : 500 });
  }
}

/** DELETE ?id=: remove one saved prompt. */
export async function DELETE(request: NextRequest) {
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return Response.json({ error: "Pass the prompt id to delete: ?id=…" }, { status: 400 });
  try {
    const removed = deletePrompt(id);
    return Response.json({ ok: removed }, { status: removed ? 200 : 404 });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to delete the prompt." }, { status: 500 });
  }
}
