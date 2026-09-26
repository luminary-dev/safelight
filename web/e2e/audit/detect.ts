/**
 * In-page audit detector for the responsive sweep (UI-RESPONSIVE-BRIEF §4).
 *
 * `auditPage` is passed to `page.evaluate()`, so it must be fully
 * self-contained: no imports, no closure references. The WCAG luminance /
 * contrast-ratio math inside it is a verbatim port of the pure functions in
 * `src/lib/theme/contrast.ts` (adapted from hex strings to [r,g,b] tuples) —
 * keep the two in sync if that file ever changes.
 *
 * Categories (exactly the brief's §4 list):
 *   overflowsViewport  element rect extends past the viewport (right > vw,
 *                      left < 0; bottom > vh only for fixed/sticky elements)
 *   clippedX/clippedY  scrollWidth/Height > clientWidth/Height where overflow
 *                      is hidden|visible|clip — content lost with no scroll
 *                      affordance. Ellipsis/line-clamp truncation is routed to
 *                      truncatedNoTitle instead (the ellipsis IS the affordance
 *                      when a title carries the full value).
 *   overlaps           pairs of interactive elements whose rects intersect and
 *                      which are both actually hit-testable (z-layered modal
 *                      stacks do not count as overlap)
 *   tinyTargets        interactive elements under 44px (vw ≤ 1023) / 32px
 *   truncatedNoTitle   active ellipsis/line-clamp with no title/aria-label
 *                      carrying the full value (self or a near ancestor)
 *   zeroSize           interactive elements with a 0 width/height that are not
 *                      deliberately hidden
 *   contrastFails      computed fg/bg below WCAG AA (4.5, or 3.0 for large
 *                      text); elements over background images and disabled
 *                      controls are skipped rather than guessed at
 *
 * Every rule skips el.closest('nextjs-portal') (the Next dev indicator, §1.5),
 * [data-audit-ignore], aria-hidden subtrees, and hidden / zero-opacity
 * elements. Each offending element is reported once per category with a
 * stable selector path, its rect, and the measured numbers.
 */

export const CATEGORIES = ["overflowsViewport", "clippedX", "clippedY", "overlaps", "tinyTargets", "truncatedNoTitle", "zeroSize", "contrastFails"] as const;
export type Category = (typeof CATEGORIES)[number];

export interface Offender {
  /** Stable-ish CSS path (ids and data-testids shorten it when present). */
  selector: string;
  /** aria-label or a text snippet, for humans reading the report. */
  label: string;
  rect: { x: number; y: number; w: number; h: number };
  /** Category-specific numbers, e.g. overflowPx, scrollWidth/clientWidth, ratio. */
  detail: Record<string, number | string>;
}

export interface AuditResult {
  /** Full counts per category (offender lists are capped, counts are not). */
  counts: Record<Category, number>;
  /** Offenders per category, capped at `maxOffenders` per category. */
  offenders: Record<Category, Offender[]>;
  viewport: { vw: number; vh: number };
  documentScrollWidth: number;
}

export interface AuditOptions {
  /** Cap on reported offenders per category (counts stay exact). */
  maxOffenders?: number;
}

export function auditPage(opts: AuditOptions = {}): AuditResult {
  const maxOffenders = opts.maxOffenders ?? 30;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const doc = document;

  // ---- shared skip rules (brief §1.5 + §4) --------------------------------
  const skip = (el: Element): boolean => {
    if (el.closest("nextjs-portal")) return true;
    if (el.closest("[data-audit-ignore]")) return true;
    if (el.closest('[aria-hidden="true"]')) return true;
    // Hidden / zero-opacity subtrees, including mid-transition states.
    type CV = { checkVisibility?: (o: Record<string, boolean>) => boolean };
    const cv = (el as unknown as CV).checkVisibility;
    if (typeof cv === "function") {
      if (!cv.call(el, { checkOpacity: true, checkVisibilityCSS: true, opacityProperty: true, visibilityProperty: true })) return true;
    } else {
      for (let n: Element | null = el; n; n = n.parentElement) {
        const cs = getComputedStyle(n);
        if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity) === 0) return true;
      }
    }
    return false;
  };

  // ---- selector path ------------------------------------------------------
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    let n: Element | null = el;
    while (n && n.nodeType === 1 && n !== doc.documentElement) {
      if (n.id) {
        parts.unshift(`#${CSS.escape(n.id)}`);
        break;
      }
      const tag = n.tagName.toLowerCase();
      const testid = n.getAttribute("data-testid");
      if (testid) {
        parts.unshift(`${tag}[data-testid="${testid}"]`);
        break;
      }
      let idx = 1;
      let sib: Element | null = n;
      while ((sib = sib.previousElementSibling)) if (sib.tagName === n.tagName) idx++;
      parts.unshift(`${tag}:nth-of-type(${idx})`);
      n = n.parentElement;
    }
    return parts.join(" > ");
  };

  const labelOf = (el: Element): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return aria;
    const text = (el.textContent || "").replace(/\s+/g, " ").trim();
    return text.slice(0, 60);
  };

  const rectOf = (r: DOMRect) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) });

  const counts: Record<Category, number> = { overflowsViewport: 0, clippedX: 0, clippedY: 0, overlaps: 0, tinyTargets: 0, truncatedNoTitle: 0, zeroSize: 0, contrastFails: 0 };
  const offenders: Record<Category, Offender[]> = { overflowsViewport: [], clippedX: [], clippedY: [], overlaps: [], tinyTargets: [], truncatedNoTitle: [], zeroSize: [], contrastFails: [] };
  const seen: Record<Category, Set<string>> = { overflowsViewport: new Set(), clippedX: new Set(), clippedY: new Set(), overlaps: new Set(), tinyTargets: new Set(), truncatedNoTitle: new Set(), zeroSize: new Set(), contrastFails: new Set() };

  const report = (cat: Category, el: Element, detail: Record<string, number | string>, key?: string) => {
    const sel = cssPath(el);
    const k = key ?? sel;
    if (seen[cat].has(k)) return;
    seen[cat].add(k);
    counts[cat]++;
    if (offenders[cat].length < maxOffenders) offenders[cat].push({ selector: sel, label: labelOf(el), rect: rectOf(el.getBoundingClientRect()), detail });
  };

  const all = Array.from(doc.body.querySelectorAll("*")).filter((el) => !skip(el));

  // Interactive elements per §4 (a → a[href]: a bare anchor is not focusable).
  const INTERACTIVE = 'button, a[href], input:not([type="hidden"]), select, textarea, [role="button"], [tabindex]:not([tabindex="-1"])';
  const interactive = all.filter((el) => el.matches(INTERACTIVE));

  const hasScrollableXAncestor = (el: Element): boolean => {
    for (let n = el.parentElement; n; n = n.parentElement) {
      const o = getComputedStyle(n).overflowX;
      if ((o === "auto" || o === "scroll") && n.scrollWidth > n.clientWidth) return true;
    }
    return false;
  };

  // ---- 1. overflowsViewport (outermost offender only, so one broken toolbar
  // is one entry; the interactive children it pushes out are counted in detail)
  const overflowing = new Set<Element>();
  for (const el of all) {
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const cs = getComputedStyle(el);
    const fixedish = cs.position === "fixed" || cs.position === "sticky";
    const off = r.right > vw + 1 || r.left < -1 || (fixedish && r.bottom > vh + 1);
    if (!off) continue;
    if (hasScrollableXAncestor(el)) continue; // reachable via a real scroll region
    overflowing.add(el);
  }
  for (const el of overflowing) {
    let ancestorFlagged = false;
    for (let n = el.parentElement; n; n = n.parentElement) if (overflowing.has(n)) { ancestorFlagged = true; break; }
    if (ancestorFlagged) continue;
    const r = el.getBoundingClientRect();
    const lost = Array.from(el.querySelectorAll(INTERACTIVE)).filter((c) => !skip(c) && c.getBoundingClientRect().right > vw);
    report("overflowsViewport", el, {
      left: Math.round(r.left),
      right: Math.round(r.right),
      overflowRightPx: Math.max(0, Math.round(r.right - vw)),
      overflowLeftPx: Math.max(0, Math.round(-r.left)),
      interactiveLost: lost.length,
      lostLabels: lost.map((c) => labelOf(c)).slice(0, 12).join(" · "),
    });
  }

  // ---- 2. clippedX / clippedY ---------------------------------------------
  for (const el of all) {
    const cs = getComputedStyle(el);
    if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
      const o = cs.overflowX;
      const truncating = cs.textOverflow.includes("ellipsis");
      if ((o === "hidden" || o === "visible" || o === "clip") && !truncating) {
        report("clippedX", el, { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, hiddenPx: el.scrollWidth - el.clientWidth, overflowX: o });
      }
    }
    if (el.scrollHeight > el.clientHeight + 1 && el.clientHeight > 0) {
      const o = cs.overflowY;
      const clamped = cs.getPropertyValue("-webkit-line-clamp") !== "none" && cs.getPropertyValue("-webkit-line-clamp") !== "";
      if ((o === "hidden" || o === "visible" || o === "clip") && !clamped) {
        report("clippedY", el, { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, hiddenPx: el.scrollHeight - el.clientHeight, overflowY: o });
      }
    }
  }

  // ---- 3. overlaps (interactive pairs, both actually hit-testable) --------
  const hitTestable = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx >= vw || cy >= vh) return false; // off-screen: unreachable, reported elsewhere
    const hit = doc.elementFromPoint(cx, cy);
    return !!hit && (hit === el || el.contains(hit) || hit.contains(el));
  };
  const inter = interactive.filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  });
  const hittable = new Map<Element, boolean>();
  for (const el of inter) hittable.set(el, hitTestable(el));
  for (let i = 0; i < inter.length; i++) {
    for (let j = i + 1; j < inter.length; j++) {
      const a = inter[i];
      const b = inter[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox <= 2 || oy <= 2) continue;
      if (!hittable.get(a) || !hittable.get(b)) continue; // covered by a legit layer (modal, popover)
      const key = [cssPath(a), cssPath(b)].sort().join(" && ");
      report("overlaps", a, { with: cssPath(b), withLabel: labelOf(b), overlapW: Math.round(ox), overlapH: Math.round(oy) }, key);
    }
  }

  // ---- 4. tinyTargets (44px at ≤1023, 32px above — brief §8) --------------
  const minTarget = vw <= 1023 ? 44 : 32;
  for (const el of inter) {
    const r = el.getBoundingClientRect();
    if (r.width < minTarget - 0.5 || r.height < minTarget - 0.5) {
      report("tinyTargets", el, { w: Math.round(r.width), h: Math.round(r.height), min: minTarget });
    }
  }

  // ---- 5. truncatedNoTitle -------------------------------------------------
  const carriesFullValue = (el: Element): boolean => {
    let n: Element | null = el;
    for (let depth = 0; n && depth < 4; depth++, n = n.parentElement) {
      if (n.getAttribute("title") || n.getAttribute("aria-label")) return true;
    }
    return false;
  };
  for (const el of all) {
    const cs = getComputedStyle(el);
    const ellipsisActive = cs.textOverflow.includes("ellipsis") && (cs.overflowX === "hidden" || cs.overflowX === "clip") && el.scrollWidth > el.clientWidth + 1;
    const clampVal = cs.getPropertyValue("-webkit-line-clamp");
    const clampActive = clampVal !== "none" && clampVal !== "" && el.scrollHeight > el.clientHeight + 1;
    if ((ellipsisActive || clampActive) && !carriesFullValue(el)) {
      report("truncatedNoTitle", el, { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, kind: ellipsisActive ? "ellipsis" : "line-clamp" });
    }
  }

  // ---- 6. zeroSize ----------------------------------------------------------
  for (const el of interactive) {
    const r = el.getBoundingClientRect();
    if ((r.width < 0.5 || r.height < 0.5) && !(el as HTMLElement).hidden) {
      report("zeroSize", el, { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 });
    }
  }

  // ---- 7. contrastFails -----------------------------------------------------
  // WCAG 2.2 math ported from src/lib/theme/contrast.ts (pure functions).
  type RGB = [number, number, number];
  const relativeLuminance = (rgb: RGB): number => {
    const [r, g, b] = rgb.map((c) => {
      const s = c / 255;
      return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrastRatio = (a: RGB, b: RGB): number => {
    const la = relativeLuminance(a);
    const lb = relativeLuminance(b);
    const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
    return (hi + 0.05) / (lo + 0.05);
  };
  const parseColor = (s: string): [number, number, number, number] | null => {
    const m = /^rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)$/.exec(s);
    if (!m) return null;
    return [parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]), m[4] === undefined ? 1 : parseFloat(m[4])];
  };
  const blend = (top: [number, number, number, number], under: RGB): RGB => {
    const a = top[3];
    return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a)];
  };
  const toHex = (rgb: RGB): string => "#" + rgb.map((c) => Math.round(c).toString(16).padStart(2, "0")).join("");

  /** Effective opaque background behind `el`, or null when a background image
   *  or unparsable color makes the answer a guess (we skip, we don't guess). */
  const effectiveBackground = (el: Element): RGB | null => {
    const layers: [number, number, number, number][] = [];
    for (let n: Element | null = el; n; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.backgroundImage !== "none") return null;
      const c = parseColor(cs.backgroundColor);
      if (!c) return null;
      if (c[3] > 0) {
        layers.push(c);
        if (c[3] >= 1) break;
      }
      if (!n.parentElement) {
        const root = parseColor(getComputedStyle(doc.documentElement).backgroundColor);
        if (root && root[3] >= 1) layers.push(root);
        else layers.push([255, 255, 255, 1]); // browser default canvas
      }
    }
    let bg: RGB = [255, 255, 255];
    if (layers.length && layers[layers.length - 1][3] >= 1) {
      const last = layers[layers.length - 1];
      bg = [last[0], last[1], last[2]];
      for (let i = layers.length - 2; i >= 0; i--) bg = blend(layers[i], bg);
    } else {
      for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    }
    return bg;
  };

  const AA_TEXT = 4.5; // same threshold constant as lib/theme/contrast.ts
  const AA_LARGE = 3.0;
  for (const el of all) {
    const hasText = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent || "").trim().length > 0);
    if (!hasText) continue;
    if (el.closest("[disabled], [aria-disabled='true'], option")) continue; // WCAG exempts disabled controls
    const cs = getComputedStyle(el);
    const fg = parseColor(cs.color);
    if (!fg) continue;
    const bg = effectiveBackground(el);
    if (!bg) continue; // background image / unparsable: skip rather than guess
    let cumOpacity = 1;
    for (let n: Element | null = el; n; n = n.parentElement) cumOpacity *= parseFloat(getComputedStyle(n).opacity) || 1;
    const effFg = blend([fg[0], fg[1], fg[2], fg[3] * cumOpacity], bg);
    const ratio = Math.round(contrastRatio(effFg, bg) * 100) / 100;
    const size = parseFloat(cs.fontSize);
    const weight = parseInt(cs.fontWeight, 10) || 400;
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const threshold = large ? AA_LARGE : AA_TEXT;
    if (ratio < threshold) {
      report("contrastFails", el, { ratio, threshold, fg: toHex(effFg), bg: toHex(bg), fontSize: Math.round(size * 10) / 10, fontWeight: weight });
    }
  }

  return { counts, offenders, viewport: { vw, vh }, documentScrollWidth: doc.documentElement.scrollWidth };
}
