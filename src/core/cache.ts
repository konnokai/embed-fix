/**
 * Thin wrapper around the Workers Cache API.
 *
 * The cache only takes effect on a Custom Domain or route, not on workers.dev,
 * and lives in a single data center. A cache failure is logged and otherwise
 * ignored: the page can always be built again.
 */

function cacheKey(url: string): Request {
  return new Request(url, { method: "GET" });
}

export async function readCache(url: string): Promise<Response | null> {
  try {
    return (await caches.default.match(cacheKey(url))) ?? null;
  } catch (error) {
    console.error(
      JSON.stringify({ event: "cache_read_failed", message: error instanceof Error ? error.message : String(error) }),
    );
    return null;
  }
}

export async function writeCache(url: string, response: Response): Promise<void> {
  try {
    await caches.default.put(cacheKey(url), response);
  } catch (error) {
    console.error(
      JSON.stringify({ event: "cache_write_failed", message: error instanceof Error ? error.message : String(error) }),
    );
  }
}
