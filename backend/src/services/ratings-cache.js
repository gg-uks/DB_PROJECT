import { createHash } from "node:crypto";
import { createClient } from "redis";

const url = process.env.REDIS_URL;
let client;
let retryAfter = 0;

function cacheClient() {
  if (!url) return null;
  if (!client && Date.now() >= retryAfter) {
    retryAfter = Date.now() + 5000;
    const connection = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 500, reconnectStrategy: false },
    });
    client = connection;
    connection.on("error", () => {
      if (!connection.isOpen && client === connection) client = undefined;
    });
    connection.connect().catch(() => {
      if (client === connection) client = undefined;
    });
  }
  return client?.isReady ? client : null;
}

export async function getCachedCatalog(scope, params, ttlSeconds, load) {
  const digest = createHash("sha256")
    .update(JSON.stringify(params))
    .digest("hex");
  const key = `playlog:${scope}:v2:${digest}`;
  const cache = cacheClient();

  if (cache) {
    try {
      const value = await cache
        .withCommandOptions({ abortSignal: AbortSignal.timeout(300) })
        .get(key);
      if (value !== null) return JSON.parse(value);
    } catch {
      // Redis is optional. MySQL remains the source of truth.
    }
  }

  const result = await load();
  const writable = cacheClient();
  if (
    writable &&
    result != null &&
    !result.invalidGameIds &&
    result.mode !== "steam-keyword-fallback"
  ) {
    try {
      await writable
        .withCommandOptions({ abortSignal: AbortSignal.timeout(300) })
        .set(key, JSON.stringify(result), { EX: ttlSeconds });
    } catch {
      // A cache write failure does not change the API response.
    }
  }
  return result;
}
