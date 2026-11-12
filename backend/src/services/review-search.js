import { STOPWORDS } from "./keyword-extractor.js";

export function hasReviewSearch() {
  return Boolean(process.env.ELASTICSEARCH_URL);
}

function reviewIndex() {
  const name = process.env.ELASTICSEARCH_INDEX || "playlog-reviews-v2";
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
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Elasticsearch ${method} ${path}: HTTP ${response.status} ${detail.slice(0, 200)}`);
  }
  return method === "HEAD" ? true : response.json();
}

/**
 * 리뷰 인덱스 매핑 (v2)
 *   text : nori 형태소 분석 → 일반명사(NNG) · 고유명사(NNP) · 영어(SL)만 남김 · 불용어 · 1글자 제거
 *          fielddata: true → terms 집계로 단어 빈도(워드클라우드)를 바로 뽑을 수 있음 (리뷰 7,500건이라 메모리 부담 작음)
 *   nori 플러그인이 없으면 기본 분석기로 만들고, 워드클라우드는 MySQL GAME_KEYWORD로 대신함
 */
const KEEP_TAGS = new Set(["NNG", "NNP", "SL"]);
// 품사 이름은 Lucene 버전마다 다름 (예: ES 7은 E · J, ES 8~9는 EC · EF · JKS …)
// → 예전 · 새 이름을 모두 후보로 두고, ES에 실제로 있는 이름만 골라서 씀
const CANDIDATE_TAGS = ["E", "EC", "EF", "EP", "ETM", "ETN", "IC", "J", "JC", "JKB", "JKC", "JKG", "JKO", "JKQ",
  "JKS", "JKV", "JX", "MAG", "MAJ", "MM", "MMA", "MMD", "MMN", "NA", "NNB", "NNBC", "NP", "NR", "SC", "SE", "SF",
  "SH", "SN", "SP", "SSC", "SSO", "SY", "UNA", "UNKNOWN", "VA", "VCN", "VCP", "VSV", "VV", "VX", "XPN", "XR", "XSA",
  "XSN", "XSV"];

async function supportedStopTags() {
  const checks = await Promise.all(
    CANDIDATE_TAGS.map((tag) =>
      elasticRequest("/_analyze", {
        body: { tokenizer: "nori_tokenizer", filter: [{ type: "nori_part_of_speech", stoptags: [tag] }], text: "테스트" },
      }).then(() => tag, () => null),
    ),
  );
  const tags = checks.filter(Boolean).filter((t) => !KEEP_TAGS.has(t));
  if (!tags.length) throw new Error("nori 품사 태그를 확인하지 못했습니다 (analysis-nori 플러그인 확인)");
  return tags;
}

export const noriIndexBody = {
  settings: {
    analysis: {
      tokenizer: { ko_tokenizer: { type: "nori_tokenizer", decompound_mode: "discard" } },
      filter: {
        ko_pos: { type: "nori_part_of_speech", stoptags: [] }, // ensureReviewIndex에서 채움
        ko_stop: { type: "stop", stopwords: [...STOPWORDS] },
        ko_len: { type: "length", min: 2, max: 20 },
      },
      analyzer: {
        ko_nouns: { type: "custom", tokenizer: "ko_tokenizer", filter: ["ko_pos", "lowercase", "ko_stop", "ko_len"] },
      },
    },
  },
  mappings: {
    properties: {
      gameId: { type: "long" },
      text: { type: "text", analyzer: "ko_nouns", fielddata: true },
      keywords: { type: "keyword" },
      recommended: { type: "boolean" },
    },
  },
};

const plainIndexBody = {
  mappings: {
    properties: {
      gameId: { type: "long" },
      text: { type: "text" },
      keywords: { type: "keyword" },
      recommended: { type: "boolean" },
    },
  },
};

export async function ensureReviewIndex({ recreate = false } = {}) {
  const index = reviewIndex();
  const exists = await elasticRequest(`/${index}`, { method: "HEAD" });
  if (exists && !recreate) return;
  if (exists) await elasticRequest(`/${index}`, { method: "DELETE" });
  try {
    const body = structuredClone(noriIndexBody);
    body.settings.analysis.filter.ko_pos.stoptags = await supportedStopTags();
    await elasticRequest(`/${index}`, { method: "PUT", body });
    console.log(`nori 인덱스 생성 · 제외 품사 ${body.settings.analysis.filter.ko_pos.stoptags.length}개 (명사 NNG · NNP · 영어 SL만 남김)`);
  } catch (error) {
    console.warn(`nori 인덱스 생성 실패 → 기본 분석기로 생성 (${error.message}). ES에 analysis-nori 플러그인을 설치하세요.`);
    await elasticRequest(`/${index}`, { method: "PUT", body: plainIndexBody });
  }
}

export async function indexReviews(reviews) {
  const index = reviewIndex();
  await ensureReviewIndex();

  for (let offset = 0; offset < reviews.length; offset += 250) {
    const body = reviews.slice(offset, offset + 250)
      .flatMap(({ id, gameId, text, keywords, recommended }) => [
        JSON.stringify({ index: { _id: String(id) } }),
        JSON.stringify({ gameId, text, keywords, recommended }),
      ]).join("\n") + "\n";
    const result = await elasticRequest(`/${index}/_bulk?refresh=false`, {
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

/**
 * 워드클라우드 (ES 집계)
 *   words       : terms 집계 — 그 게임 리뷰에서 많이 나온 단어 (doc_count = 그 단어가 나온 리뷰 수)
 *   distinctive : significant_text — 다른 게임보다 이 게임에서 유독 많이 나온 단어
 * nori 매핑이 아니면(fielddata 없음) 오류 → 호출한 쪽에서 MySQL로 대신함
 */
export async function reviewWordCloud(gameId, side, limit) {
  const filter = [{ term: { gameId } }];
  if (side !== "all") filter.push({ term: { recommended: side === "pos" } });
  const result = await elasticRequest(`/${reviewIndex()}/_search`, {
    body: {
      size: 0,
      track_total_hits: true,
      query: { bool: { filter } },
      aggs: {
        words: { terms: { field: "text", size: limit, min_doc_count: 2 } },
        distinctive: {
          sampler: { shard_size: 1000 },
          aggs: { terms: { significant_text: { field: "text", size: Math.min(limit, 30), filter_duplicate_text: true } } },
        },
      },
    },
  });
  if (result.timed_out || result._shards?.failed) throw new Error("Elasticsearch returned partial results");
  const total = result.hits.total?.value ?? 0;
  return {
    total,
    words: result.aggregations.words.buckets.map((b) => ({ word: b.key, count: b.doc_count })),
    distinctive: result.aggregations.distinctive.terms.buckets.map((b) => ({
      word: b.key,
      count: b.doc_count,
      score: Math.round(b.score * 1000) / 1000,
    })),
  };
}
