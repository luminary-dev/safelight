import { clearPendingQueue, getQueue } from "@/lib/comfy/client";

/** Removes every pending (not running) job from ComfyUI's queue. */
export async function DELETE() {
  try {
    const before = await getQueue();
    await clearPendingQueue();
    return Response.json({ ok: true, cleared: before.queue_pending.length });
  } catch (err) {
    return Response.json({ error: err instanceof Error ? err.message : "Failed to clear the queue." }, { status: 502 });
  }
}
