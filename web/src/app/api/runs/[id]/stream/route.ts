import type { NextRequest } from "next/server";
import { getRunEntry, subscribeRun, unsubscribeRun, type RunStreamEvent, type RunSubscriber } from "@/lib/agent/run-registry";
import { getEventsSince, getRunRow } from "@/lib/agent/runs-store";
import type { AgentEvent } from "@/lib/agent/tools";

/**
 * Re-attach to a run: replays the persisted events from ?from=<seq> (default 0),
 * then — if the run is still live — subscribes for the rest, all on the same
 * NDJSON contract as the original POST response. Ends with {type:"done"}.
 *
 * The subscription is taken BEFORE the DB read and buffered, then flushed by
 * sequence number after the replay, so no event at the replay/live boundary is
 * lost or duplicated.
 */
export async function GET(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const raw = Number(new URL(request.url).searchParams.get("from") ?? 0);
  const from = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
  const row = getRunRow(id);
  const entry = getRunEntry(id);
  if (!row && !entry) return Response.json({ error: "No such run." }, { status: 404 });

  const encoder = new TextEncoder();
  let subscriber: RunSubscriber | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let open = true;
      const send = (e: RunStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(e) + "\n"));
        } catch {
          open = false;
        }
      };
      const finish = () => {
        if (!open) return;
        open = false;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      send({ type: "run", id });
      let lastSeq = from - 1;
      let replayDone = false;
      const buffered: { event: AgentEvent; seq: number }[] = [];
      if (entry && !entry.done) {
        const candidate: RunSubscriber = {
          event: (event, seq) => {
            if (!replayDone) {
              buffered.push({ event, seq });
              return;
            }
            if (seq > lastSeq) {
              lastSeq = seq;
              send(event);
            }
          },
          end: () => {
            send({ type: "done" });
            finish();
          },
        };
        subscriber = subscribeRun(id, candidate) ? candidate : null;
      }

      for (const ev of getEventsSince(id, from)) {
        lastSeq = Math.max(lastSeq, ev.seq);
        send(ev.data);
      }
      replayDone = true;
      for (const b of buffered) {
        if (b.seq > lastSeq) {
          lastSeq = b.seq;
          send(b.event);
        }
      }
      buffered.length = 0;

      if (!subscriber) {
        // The run already finished (or predates the registry): the log is complete.
        send({ type: "done" });
        finish();
        return;
      }
      // Closing this view never stops the run; it just unsubscribes.
      request.signal.addEventListener("abort", () => {
        if (subscriber) unsubscribeRun(id, subscriber);
        finish();
      });
    },
    cancel() {
      if (subscriber) unsubscribeRun(id, subscriber);
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" } });
}
