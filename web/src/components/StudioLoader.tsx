"use client";

import dynamic from "next/dynamic";

/** The studio depends on browser APIs (websocket, localStorage), so it renders on the client only. */
const Studio = dynamic(() => import("./Studio").then((m) => m.Studio), {
  ssr: false,
  loading: () => <div className="h-[100dvh] bg-bg" aria-busy="true" />,
});

export function StudioLoader() {
  return <Studio />;
}
