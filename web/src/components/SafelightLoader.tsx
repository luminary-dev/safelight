"use client";

import dynamic from "next/dynamic";

/** Safelight depends on browser APIs (websocket, localStorage), so it renders on the client only. */
const Safelight = dynamic(() => import("./Safelight").then((m) => m.Safelight), {
  ssr: false,
  loading: () => <div className="h-[100dvh] bg-bg" aria-busy="true" />,
});

export function SafelightLoader() {
  return <Safelight />;
}
