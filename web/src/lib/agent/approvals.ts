import "server-only";

/** In-flight permission questions from a running agent, resolved by /api/code/approve. */
const pending = new Map<string, { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }>();

/** Waits for the user's Allow/Deny. Times out to a deny so an abandoned run never hangs. */
export function waitForApproval(id: string, timeoutMs = 180000): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(false);
    }, timeoutMs);
    pending.set(id, { resolve, timer });
  });
}

export function resolveApproval(id: string, allow: boolean): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  clearTimeout(entry.timer);
  pending.delete(id);
  entry.resolve(allow);
  return true;
}
