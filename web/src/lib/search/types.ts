export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchProvider {
  /** Short stable id, shown in the UI ("brave", "tavily", "ddg"). */
  id: string;
  /** False when the provider cannot run here (e.g. missing API key) — the chain skips it. */
  available(): boolean;
  search(query: string, signal: AbortSignal): Promise<SearchResult[]>;
}
