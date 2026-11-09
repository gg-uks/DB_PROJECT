/**
 * 리뷰 본문(비정형) → 명사 키워드(정형)
 *
 * 1순위: Elasticsearch nori 형태소 분석 (_analyze, 일반명사 NNG · 고유명사 NNP · 영어 SL만)
 *        → ES에 analysis-nori 플러그인 필요:  bin/elasticsearch-plugin install analysis-nori
 * 2순위: ES가 없거나 nori가 없으면 간이 추출 (한글 조사 · 어미를 떼는 규칙 기반)
 *        → 개발 PC에서도 테이블을 채워 볼 수 있게 하기 위한 대체 방법
 */

export const STOPWORDS = new Set([
  // 리뷰에 너무 흔해서 의미가 없는 말
  "게임", "겜", "진짜", "정말", "그냥", "너무", "완전", "약간", "조금", "좀", "많이", "제일", "가장",
  "생각", "느낌", "사람", "정도", "부분", "이거", "저거", "그거", "여기", "거기", "하나", "자체", "때문",
  "이번", "다음", "지금", "처음", "계속", "다시", "그때", "추천", "비추", "비추천", "평가", "리뷰",
  "시작", "이상", "이하", "정말로", "그리고", "그래서", "하지만", "근데", "그런데", "또한", "역시",
  "the", "and", "for", "this", "that", "with", "game", "games", "you", "are", "but", "not", "its",
]);

const JOSA = [
  "에서부터", "으로부터", "이라도", "이라서", "이라는", "에서는", "에게서", "한테서", "까지는", "부터는",
  "처럼", "보다", "에서", "에게", "한테", "까지", "부터", "이랑", "하고", "으로", "라도", "이나", "만큼",
  "랑", "로", "은", "는", "이", "가", "을", "를", "의", "도", "만", "와", "과", "에", "께", "나", "요",
];
const VERB_END = /(하다|했다|합니다|해요|했어요|하는|하고|해서|했고|했는데|한데|하게|하면|이다|입니다|이에요|예요|네요|어요|아요|었다|았다|습니다|ㅂ니다|는데|지만|니까|으면|면서|다고|라고|던|겠다)$/;

function simpleNouns(text) {
  const words = [];
  for (const raw of text.toLowerCase().split(/[^0-9a-z가-힣]+/)) {
    if (!raw) continue;
    if (/^[a-z][a-z0-9]{2,}$/.test(raw)) {
      words.push(raw);
      continue;
    }
    if (!/^[가-힣]+$/.test(raw) || VERB_END.test(raw)) continue;
    let word = raw;
    for (const josa of JOSA) {
      if (word.length > josa.length + 1 && word.endsWith(josa)) {
        word = word.slice(0, -josa.length);
        break;
      }
    }
    if (word.length >= 2 && word.length <= 10) words.push(word);
  }
  return words;
}

let noriAvailable = null; // null = 아직 확인 안 함

async function noriNouns(text) {
  const base = process.env.ELASTICSEARCH_URL.replace(/\/+$/, "");
  const headers = { "Content-Type": "application/json" };
  if (process.env.ELASTICSEARCH_API_KEY) headers.Authorization = `ApiKey ${process.env.ELASTICSEARCH_API_KEY}`;
  const response = await fetch(`${base}/_analyze`, {
    method: "POST",
    headers,
    body: JSON.stringify({ tokenizer: "nori_tokenizer", explain: true, text: text.slice(0, 5000) }),
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`nori _analyze HTTP ${response.status}`);
  const result = await response.json();
  const tokens = result.detail?.tokenizer?.tokens ?? [];
  return tokens
    .filter((t) => /^(NNG|NNP|SL)/.test(t.leftPOS ?? ""))
    .map((t) => t.token.toLowerCase())
    .filter((w) => (/^[a-z]/.test(w) ? w.length >= 3 : w.length >= 2));
}

/** 명사 목록 → [{ word, tf }] (불용어 제거 · 50자 제한) */
export function countWords(words) {
  const counts = new Map();
  for (const word of words) {
    if (STOPWORDS.has(word) || word.length > 50) continue;
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts].map(([word, tf]) => ({ word, tf: Math.min(tf, 65535) }));
}

/** 본문에서 키워드와 등장 횟수 추출. 사용한 방법(method)도 함께 반환 */
export async function extractKeywords(text) {
  if (typeof text !== "string" || !text.trim()) return { method: "empty", keywords: [] };
  const wantNori = process.env.ELASTICSEARCH_URL && process.env.KEYWORD_ANALYZER !== "simple";
  if (wantNori && noriAvailable !== false) {
    try {
      const keywords = countWords(await noriNouns(text));
      noriAvailable = true;
      return { method: "nori", keywords };
    } catch (error) {
      if (noriAvailable === null) {
        console.warn(`nori 사용 불가 → 간이 추출로 진행 (${error.message})`);
        noriAvailable = false;
      } else throw error;
    }
  }
  return { method: "simple", keywords: countWords(simpleNouns(text)) };
}
