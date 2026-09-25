"use client";

import { useEffect, useRef, useState } from "react";

export interface ProgressState {
  connected: boolean;
  /** prompt_id currently executing on the server, if any */
  activePromptId: string | null;
  /** 0..1 sampling progress for the active prompt */
  progress: number;
  step: number;
  totalSteps: number;
  /** class_type of the node currently running, e.g. KSampler */
  nodeLabel: string | null;
  queueRemaining: number;
  /** latest preview frame as a blob URL, if the server sends latent previews */
  preview: string | null;
}

const INITIAL: ProgressState = {
  connected: false,
  activePromptId: null,
  progress: 0,
  step: 0,
  totalSteps: 0,
  nodeLabel: null,
  queueRemaining: 0,
  preview: null,
};

/**
 * Subscribes to ComfyUI's websocket for live progress. The socket speaks directly to the
 * backend since progress events are only published over websockets.
 */
export function useComfySocket(clientId: string, wsUrl: string) {
  const [state, setState] = useState<ProgressState>(INITIAL);
  const previewRef = useRef<string | null>(null);
  const [finished, setFinished] = useState<string[]>([]);

  useEffect(() => {
    if (!clientId) return;
    let socket: WebSocket | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      socket = new WebSocket(`${wsUrl}/ws?clientId=${clientId}`);
      socket.binaryType = "arraybuffer";

      socket.onopen = () => setState((s) => ({ ...s, connected: true }));
      socket.onclose = () => {
        setState((s) => ({ ...s, connected: false }));
        if (!closed) retry = setTimeout(connect, 2000);
      };
      socket.onerror = () => socket?.close();

      socket.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          // Binary frames: 4-byte event type, 4-byte image format, then image bytes.
          const view = new DataView(event.data);
          const eventType = view.getUint32(0);
          if (eventType === 1) {
            const format = view.getUint32(4);
            const mime = format === 1 ? "image/jpeg" : "image/png";
            const blob = new Blob([event.data.slice(8)], { type: mime });
            if (previewRef.current) URL.revokeObjectURL(previewRef.current);
            previewRef.current = URL.createObjectURL(blob);
            setState((s) => ({ ...s, preview: previewRef.current }));
          }
          return;
        }
        let msg: { type: string; data: Record<string, unknown> };
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        const d = msg.data ?? {};
        switch (msg.type) {
          case "status": {
            const remaining = ((d.status as { exec_info?: { queue_remaining?: number } })?.exec_info?.queue_remaining ?? 0) as number;
            setState((s) => ({ ...s, queueRemaining: remaining }));
            break;
          }
          case "execution_start":
            setState((s) => ({ ...s, activePromptId: d.prompt_id as string, progress: 0, step: 0, totalSteps: 0, preview: null }));
            break;
          case "executing":
            if (d.node === null) {
              const id = d.prompt_id as string;
              setFinished((f) => (f.includes(id) ? f : [...f, id]));
              setState((s) => ({ ...s, activePromptId: null, nodeLabel: null, progress: 1 }));
            } else {
              const node = (d.display_node as string) ?? (d.node as string);
              // A new node starting means the previous stage's counters no longer apply.
              setState((s) => ({
                ...s,
                activePromptId: (d.prompt_id as string) ?? s.activePromptId,
                nodeLabel: node,
                ...(node !== s.nodeLabel ? { progress: 0, step: 0, totalSteps: 0 } : {}),
              }));
            }
            break;
          case "progress": {
            const value = d.value as number;
            const max = d.max as number;
            setState((s) => ({ ...s, progress: max ? value / max : 0, step: value, totalSteps: max, nodeLabel: (d.node as string) ?? s.nodeLabel }));
            break;
          }
          case "execution_error":
          case "execution_interrupted": {
            const id = d.prompt_id as string;
            setFinished((f) => (f.includes(id) ? f : [...f, id]));
            setState((s) => ({ ...s, activePromptId: null, nodeLabel: null }));
            break;
          }
          default:
            break;
        }
      };
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socket?.close();
      if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    };
  }, [clientId, wsUrl]);

  return { ...state, finished };
}
