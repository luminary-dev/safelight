import type { JobOutput } from "@/lib/comfy/types";
import { viewUrl } from "@/lib/safelight-state";

/** One indexed row from /api/library. `path` is relative to the outputs folder. */
export interface LibraryItem {
  path: string;
  mtime: number;
  size: number;
  width: number | null;
  height: number | null;
  model: string | null;
  seed: number | null;
  prompt: string | null;
  meta: string | null;
  favorite: number;
  tags: string[];
}

export interface Facet {
  value: string;
  count: number;
}

export interface LibraryFacets {
  models: Facet[];
  tags: Facet[];
}

export interface LibraryResponse {
  items: LibraryItem[];
  total: number;
  facets: LibraryFacets;
}

/** Duplicate-view rows carry no tags/meta. */
export type DupItem = Omit<LibraryItem, "tags" | "meta">;

export interface DuplicateGroup {
  items: DupItem[];
  spread: number;
}

export function toJobOutput(item: Pick<LibraryItem, "path">): JobOutput {
  const slash = item.path.lastIndexOf("/");
  return { filename: slash === -1 ? item.path : item.path.slice(slash + 1), subfolder: slash === -1 ? "" : item.path.slice(0, slash), type: "output" };
}

export function fullUrl(item: Pick<LibraryItem, "path">): string {
  return viewUrl(toJobOutput(item));
}

export function thumbUrl(item: Pick<LibraryItem, "path">): string {
  return `/api/library/thumb?path=${encodeURIComponent(item.path)}`;
}

// Size and date formatting moved to @/lib/i18n-format (formatBytes / formatDate),
// which route through Intl with the active locale.
