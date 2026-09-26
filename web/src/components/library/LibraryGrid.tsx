"use client";

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import type { LibraryItem } from "./types";

const GAP = 14;
const MIN_TILE = 190;
const OVERSCAN = 3;

/**
 * Hand-rolled windowed grid: the spacer is sized for the full result set, only
 * the visible rows (plus overscan) render, and scrolling near unloaded indices
 * asks the parent for the next page. No virtualization dependency.
 */
export function LibraryGrid({
  items,
  total,
  onNeedMore,
  renderTile,
}: {
  items: LibraryItem[];
  total: number;
  onNeedMore: () => void;
  renderTile: (item: LibraryItem) => ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const raf = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [box, setBox] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onScroll = useCallback(() => {
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      if (ref.current) setScrollTop(ref.current.scrollTop);
    });
  }, []);
  useEffect(() => () => cancelAnimationFrame(raf.current), []);

  const cols = Math.max(2, Math.floor((box.w + GAP) / (MIN_TILE + GAP)));
  const tileW = box.w > 0 ? (box.w - GAP * (cols - 1)) / cols : 0;
  const rowH = tileW + GAP;
  const totalRows = Math.ceil(total / cols);
  const firstRow = rowH > 0 ? Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN) : 0;
  const lastRow = rowH > 0 ? Math.min(totalRows - 1, Math.ceil((scrollTop + box.h) / rowH) + OVERSCAN) : 0;
  const start = firstRow * cols;
  const end = Math.min((lastRow + 1) * cols, total);

  // Side effect out of render: fetch when the window reaches past what is loaded.
  useEffect(() => {
    if (end > items.length && items.length < total) onNeedMore();
  }, [end, items.length, total, onNeedMore]);

  return (
    <div ref={ref} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto pb-4">
      <div className="relative" style={{ height: totalRows * rowH }}>
        {box.w > 0
          ? items.slice(start, Math.min(end, items.length)).map((item, k) => {
              const idx = start + k;
              const r = Math.floor(idx / cols);
              const c = idx % cols;
              return (
                <div key={item.path} className="absolute" style={{ top: r * rowH, left: c * (tileW + GAP), width: tileW, height: tileW }}>
                  {renderTile(item)}
                </div>
              );
            })
          : null}
      </div>
    </div>
  );
}
