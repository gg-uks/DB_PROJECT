export function hasReviewSearch() {
  return Boolean(process.env.ELASTICSEARCH_URL);
}

function reviewIndex() {
  const name = process.env.ELASTICSEARCH_INDEX || "playlog-reviews-v1";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error("Invalid ELASTICSEARCH_INDEX");
  }
  return name;
}

async function elasticRequest(path, { method = "POST", body, ndjson = false } = {}) {
  const base = process.env.ELASTICSEARCH_URL;
  if (!base) throw new Error("ELASTICSEARCH_URL is required");
  const headers = {};
  const key = process.env.ELASTICSEARCH_API_KEY;
  if (key) headers.Authorization = `ApiKey ${key}`;
  if (body !== undefined) {
    headers["Content-Type"] = ndjson ? "application/x-ndjson" : "application/json";
  }

  const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
    method,
    headers,
    body: ndjson ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });

  if (method === "HEAD" && response.status === 404) return false;
  if (!response.ok) throw new Error(`Elasticsearch ${method} ${path}: HTTP ${response.status}`);
  return method === "HEAD" ? true : response.json();
}

export async function indexReviews(reviews) {
  const index = reviewIndex();
  if (!(await elasticRequest(`/${index}`, { method: "HEAD" }))) {
    await elasticRequest(`/${index}`, {
      method: "PUT",
      body: {
        mappings: {
          properties: {
            gameId: { type: "long" },
            text: { type: "text" },
            keywords: { type: "keyword" },
            recommended: { type: "boolean" },
          },
        },
      },
    });
  }

  for (let offset = 0; offset < reviews.length; offset += 250) {
    const body = reviews.slice(offset, offset + 250)
      .flatMap(({ id, gameId, text, keywords, recommended }) => [
        JSON.stringify({ index: { _id: String(id) } }),
        JSON.stringify({ gameId, text, keywords, recommended }),
      ]).join("\n") + "\n";
    const result = await elasticRequest(`/${index}/_bulk?refresh=wait_for`, {
      body,
      ndjson: true,
    });
    if (result.errors) {
      const failed = result.items.find(({ index }) => index.error)?.index;
      throw new Error(`Review indexing failed: ${failed?._id ?? "unknown"} (${failed?.error.type ?? "unknown"})`);
    }
  }
}

export async function searchReviewGames(query) {
  const result = await elasticRequest(`/${reviewIndex()}/_search`, {
    body: {
      size: 100,
      track_total_hits: false,
      _source: ["gameId"],
      collapse: { field: "gameId" },
      query: {
        multi_match: { query, fields: ["text", "keywords^2"] },
      },
    },
  });
  if (result.timed_out || result._shards.failed) {
    throw new Error("Elasticsearch returned partial results");
  }
  return result.hits.hits.map((hit) => ({
    id: hit._source.gameId,
    score: hit._score,
  }));
}
