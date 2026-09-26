/*
  The isolated server is `next dev`: routes compile on first hit, and a busy CI
  runner can blow a test's timeout on that first compile. Warm the routes the
  suite touches once, with a generous budget, before any test runs.
*/
export default async function globalSetup(config) {
  const base = config.projects[0].use.baseURL;
  const warm = ["/", "/api/health", "/api/sessions", "/api/settings", "/api/themes", "/api/blueprints", "/api/keys", "/api/mcp", "/api/library", "/api/gallery"];
  for (const path of warm) {
    const start = Date.now();
    try {
      await fetch(base + path, { signal: AbortSignal.timeout(120000) });
      console.log(`[prewarm] ${path} ${Date.now() - start}ms`);
    } catch (err) {
      console.log(`[prewarm] ${path} failed: ${err}`);
    }
  }
}
