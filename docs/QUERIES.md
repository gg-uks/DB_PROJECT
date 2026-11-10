# PLAYLOG 쿼리 전체 — SQL · MongoDB · Elasticsearch · Redis · Kafka

| 저장소 | 어디에 정리했나 |
|---|---|
| **MySQL (SQL 34개)** | [`backend/db/ALL_QUERIES.sql`](../backend/db/ALL_QUERIES.sql) — 코드에서 쓰는 SQL 그대로 · 주석 설명 · Workbench에서 ⚡ 실행 가능 (INSERT · UPDATE · DELETE는 `/* */` 안) |
| SQL 설명 | [`backend/db/QUERIES.md`](../backend/db/QUERIES.md) |
| 테이블 정의 | [`backend/db/schema.sql`](../backend/db/schema.sql) (실제 DB) · [`backend/db/erdcloud.sql`](../backend/db/erdcloud.sql) (ERDCloud용) |
| MongoDB · Elasticsearch · Redis · Kafka | 이 문서 2 ~ 5절 |
| 성능 측정 (EXPLAIN · 속도) | 이 문서 6절 · [`backend/db/perf/`](../backend/db/perf/README.md) |

---

## 1. MySQL — SQL 목록 (번호 = `ALL_QUERIES.sql` 안 번호)

### [A] 수집 — Steam API → MySQL
| 번호 | 쿼리 | 쓰는 곳 | SQL 기법 |
|---|---|---|---|
| A-1 | 게임 상세 저장 | `collect-game-details.mjs` · 매일 03:00 | `INSERT … ON DUPLICATE KEY UPDATE` · `COALESCE` · 트랜잭션 |
| A-2 | 개발사 · 배급사 | 〃 | `INSERT IGNORE` · 연결 DELETE 후 재삽입 · PK에 role 포함 |
| A-3 | 장르 · 카테고리 | 〃 | 스팀 번호를 PK로 · UPSERT · N:M 연결 |
| A-4 | 주간 순위 | `collect-ranks.mjs` · 05:00 | `UPDATE … WHERE appid` |
| A-5 | 새 리뷰 시작점 | `steam-reviews.mjs produce` | `LEFT JOIN` + `GROUP BY` · `MAX(CASE WHEN …)` |
| A-6 | 리뷰 저장 | Kafka consumer | 후보키 `UNIQUE(appid, steamid)` · UPSERT · `mongo_id` 연결 |
| A-7 | API 호출 기록 | `api-log.js` | INSERT · FK 없는 로그 테이블 |

### [B] 가공 — 매일 04:30
| 번호 | 쿼리 | 쓰는 곳 | SQL 기법 |
|---|---|---|---|
| B-1 | 표본 정리 (최신 125건) | `trim-reviews.mjs` | `ROW_NUMBER() OVER (PARTITION BY appid, voted_up …)` 윈도 함수 |
| B-2 | 키워드 안 뽑은 리뷰 | `extract-keywords.mjs` | `NOT EXISTS` 상관 서브쿼리 · 키셋 페이지네이션 |
| B-3 | 키워드 저장 | 〃 | `INSERT IGNORE` 다중 VALUES · `ON DUPLICATE KEY UPDATE tf = tf + VALUES(tf)` |
| B-4 | 게임별 키워드 집계 | `aggregate-keywords.mjs` | `INSERT … SELECT` + `GROUP BY` (의도적 반정규화) |

### [C] 화면 조회 — 모두 Replica(readPool)
| 번호 | 쿼리 | API | SQL 기법 |
|---|---|---|---|
| C-0 | 뷰 `V_GAME_SUMMARY` | 목록 · 상세 · 찜 공통 | VIEW · `CASE` · `NULLIF` · 상관 서브쿼리 |
| C-1 | 메인 카드 목록 | `GET /api/games` | 상관 서브쿼리 + `GROUP_CONCAT` · `CAST AS SIGNED` |
| C-2 | 필터 · 정렬 | `GET /api/analytics/games` | `IN (서브쿼리)` · `ORDER BY x IS NULL` · 정렬 화이트리스트 |
| C-3 | 필터 선택지 | `GET /api/analytics/filters` | `JOIN` + `GROUP BY` + `COUNT` |
| C-4 | 게임 상세 | `GET /api/analytics/games/:id/info` | `JOIN USING` · `GROUP BY voted_up` · `SUM(조건)` |
| C-5 | 키워드 비율 | `…/keywords?side` | 집계 테이블 + 분모는 REVIEW에서 `COUNT` |
| C-6 | 시간대별 키워드 | `…/keywords?band` | 3중 JOIN · 범위 조건 |
| C-7 | 비슷한 게임 · 추천 | `…/similar` · `POST /api/recommendations` | FROM 절 파생 테이블 → 비율 벡터 → 코사인(Node) |
| C-8 | 키워드로 게임 찾기 | `GET /api/analytics/search` | `IN` · `NOT IN` 서브쿼리 · `HAVING COUNT(*) = 단어 수` |
| C-9 | 워드클라우드 (ES 장애 시) | `…/wordcloud` | `GROUP BY` · `ORDER BY` · `LIMIT` |
| C-10 | 리뷰 목록 | `GET /api/games/:id/reviews` | 정렬 선택 · `LIMIT/OFFSET` · `CASE` 구간 · 본문은 MongoDB |
| C-11 | 평가 막대 | `GET /api/game-ratings` | `WHERE appid IN (…)` |

### [D] 회원 · 찜
| 번호 | 쿼리 | API | SQL 기법 |
|---|---|---|---|
| D-1 | 회원가입 | `POST /api/auth/signup` | INSERT · `email UNIQUE` → 409 |
| D-2 | 로그인 | `POST /api/auth/login` | 이메일로 해시 조회 · 세션 INSERT(`DATE_ADD`) |
| D-3 | 로그인 확인 | `GET /api/auth/me` | `MEMBER_SESSION JOIN MEMBER` · `expires_at > NOW()` |
| D-4 | 찜 목록 · 추가 · 삭제 | `/api/me/wishlist` | 뷰 JOIN · `ON DUPLICATE KEY` |
| D-5 | 마이페이지 요약 | `GET /api/me/summary` | `SUM(CASE)` · `AVG` · 3중 JOIN · `DATEDIFF` |
| D-6 | 계정 설정 · 탈퇴 | `/api/me` | UPDATE · `ON DELETE CASCADE` |

### [E] 관리자 통계
| 번호 | 쿼리 | API | SQL 기법 |
|---|---|---|---|
| E-1 | 핵심 지표 | `GET /api/admin/overview` | 스칼라 서브쿼리 11개 · 테이블 행 수 |
| E-2 | 수집 현황 | `GET /api/admin/api-log` | 조건 집계 · `GROUP BY` 별칭 (ONLY_FULL_GROUP_BY) · `LEFT JOIN` |
| E-3 | 게임별 수집 상태 | `GET /api/admin/games` | 파생 테이블 3개 `LEFT JOIN` + `COALESCE` |
| E-4 | 회원 | `GET /api/admin/members` | 상관 서브쿼리 · 일별 추이 |
| E-5 | 전체 상위 키워드 | `GET /api/admin/keywords` | `COUNT(DISTINCT)` · `GROUP BY` |

### SQL 기법별 찾아보기
| 기법 | 쿼리 |
|---|---|
| INNER JOIN | C-1 · C-3 ~ C-8 · D-3 ~ D-5 · E-5 |
| LEFT JOIN | A-5 · E-2 · E-3 |
| 상관 서브쿼리 | C-0 · C-1 · B-2(NOT EXISTS) · E-3 · E-4 |
| IN / NOT IN 서브쿼리 | C-2 · C-8 |
| FROM 절 파생 테이블 | B-1 · C-7 · C-8 · E-3 |
| 스칼라 서브쿼리 | E-1 |
| GROUP BY · HAVING | B-4 · C-3 ~ C-9 · D-5 · E-2 · E-4 · E-5 / HAVING: C-8 |
| 윈도 함수 | B-1 |
| UPSERT | A-1 · A-3 · A-6 · B-3 · D-4 |
| INSERT … SELECT | B-4 |
| 트랜잭션 | A-1 ~ A-3 · B-4 |
| VIEW | C-0 |
| CASE · 조건 집계 | A-5 · C-0 · C-4 · C-10 · D-5 · E-2 |

---

## 2. MongoDB (playlog DB · mongosh)

컬렉션 2개: `review_text`(리뷰 원문 · 문서 1개 = 리뷰 1건), `game_raw`(appdetails 원본 · `_id` = appid).

```js
// 접속
mongosh "mongodb://playlog:<MONGO_PASSWORD_URL인코딩>@192.168.56.22:27017,192.168.56.24:27017,192.168.56.25:27017/playlog?replicaSet=rs0&authSource=playlog"

// 인덱스 (consumer가 시작할 때 만듦)
db.review_text.createIndex({ reviewId: 1 }, { unique: true })

// A-6 리뷰 원문 저장 (consumer) — 있으면 갱신, 없으면 추가
db.review_text.findOneAndUpdate(
  { reviewId: "212345678" },
  { $set: { reviewId: "212345678", appid: 413150, original: "…", cleaned: "…", collectedAt: new Date(), raw: { /* API 응답 */ } } },
  { upsert: true, returnDocument: "after", projection: { _id: 1 } }
)   // → 받은 _id를 MySQL REVIEW.mongo_id에 저장

// A-6 같은 작성자의 예전 리뷰 원문 삭제
db.review_text.deleteOne({ reviewId: "200000000" })

// A-1 게임 상세 원본 보관
db.game_raw.updateOne({ _id: 413150 }, { $set: { name: "…", shortDescription: "…", raw: { /* appdetails */ }, collectedAt: new Date() } }, { upsert: true })

// C-10 리뷰 목록 본문 — MySQL에서 고른 mongo_id 10개로
db.review_text.find({ _id: { $in: [ObjectId("…"), ObjectId("…")] } }, { original: 1, cleaned: 1, appid: 1 })

// B-2 키워드 추출할 본문
db.review_text.find({ _id: { $in: [/* mongo_id 200개 */] } }, { cleaned: 1, original: 1, reviewId: 1 })

// B-1 표본 정리 때 원문도 함께 삭제
db.review_text.deleteMany({ _id: { $in: [/* 지울 mongo_id */] } })

// 확인용
db.review_text.countDocuments()                          // = MySQL REVIEW 행 수
db.review_text.countDocuments({ appid: 413150 })
db.review_text.findOne({}, { reviewId: 1, appid: 1, original: 1 })
db.game_raw.countDocuments()                             // = 게임 수
db.game_raw.findOne({ _id: 413150 }, { name: 1, screenshots: 1 })
rs.status().members.map(m => [m.name, m.stateStr])        // 클러스터 상태
```

---

## 3. Elasticsearch (http://192.168.56.33:9200)

### 인덱스 만들기 — `playlog-reviews-v2` (nori · 명사만)
```bash
curl -X PUT localhost:9200/playlog-reviews-v2 -H 'Content-Type: application/json' -d '{
  "settings": { "analysis": {
    "tokenizer": { "ko_tokenizer": { "type": "nori_tokenizer", "decompound_mode": "discard" } },
    "filter": {
      "ko_pos":  { "type": "nori_part_of_speech", "stoptags": ["EC","EF","EP","ETM","ETN","JKS","JKC","JKG","JKO","JKB","JKV","JKQ","JX","JC","MAG","MAJ","MM","IC","VV","VA","VX","VCP","VCN","NP","NR","NNB","XPN","XSN","XSV","XSA","XR","SF","SE","SSO","SSC","SC","SY","SN","SH"] },
      "ko_stop": { "type": "stop", "stopwords": ["게임","진짜","정말","그냥","너무","추천","비추천"] },
      "ko_len":  { "type": "length", "min": 2, "max": 20 }
    },
    "analyzer": { "ko_nouns": { "type": "custom", "tokenizer": "ko_tokenizer", "filter": ["ko_pos","lowercase","ko_stop","ko_len"] } }
  } },
  "mappings": { "properties": {
    "gameId":      { "type": "long" },
    "text":        { "type": "text", "analyzer": "ko_nouns", "fielddata": true },
    "keywords":    { "type": "keyword" },
    "recommended": { "type": "boolean" }
  } }
}'
```
- 실제로는 앱이 만든다: `npm run reviews:index -w backend -- --recreate`
- `stoptags` = 버릴 품사 (조사 · 어미 · 동사 · 형용사 · 부사 …). 일반명사 NNG · 고유명사 NNP · 영어 SL만 남긴다. 위 목록은 ES 8 ~ 9 품사 이름 기준 예시이고, ES 버전마다 이름이 달라 앱은 `_analyze`로 쓸 수 있는 태그를 확인해서 넣는다 (VM에서는 45개). 실제 값: `curl -s localhost:9200/playlog-reviews-v2/_settings?pretty`
- 불용어 전체는 `backend/src/services/keyword-extractor.js`의 `STOPWORDS` (위 `ko_stop`은 일부만 적음).

### 형태소 분석 — B-3 키워드 추출
```bash
curl -s localhost:9200/_analyze -H 'Content-Type: application/json' \
  -d '{ "tokenizer": "nori_tokenizer", "explain": true, "text": "친구들이랑 하면 시간 순삭" }'
# → tokens 중 leftPOS가 NNG · NNP · SL인 것만 키워드로 저장
```

### 색인 — consumer (1건씩) · 재색인 (일괄)
```bash
curl -s -X POST 'localhost:9200/playlog-reviews-v2/_bulk?refresh=false' -H 'Content-Type: application/x-ndjson' --data-binary $'
{"index":{"_id":"212345678"}}
{"gameId":413150,"text":"친구랑 하면 시간 순삭","keywords":[],"recommended":true}
'
```

### 워드클라우드 — terms + significant_text 집계
```bash
curl -s localhost:9200/playlog-reviews-v2/_search -H 'Content-Type: application/json' -d '{
  "size": 0, "track_total_hits": true,
  "query": { "bool": { "filter": [ { "term": { "gameId": 413150 } }, { "term": { "recommended": true } } ] } },
  "aggs": {
    "words":       { "terms": { "field": "text", "size": 60, "min_doc_count": 2 } },
    "distinctive": { "sampler": { "shard_size": 1000 },
                     "aggs": { "terms": { "significant_text": { "field": "text", "size": 30, "filter_duplicate_text": true } } } }
  }
}'
```
- `words` = 이 게임 추천 리뷰에서 많이 나온 단어 · `distinctive` = 다른 게임보다 이 게임에서 유독 많이 나온 단어

### 자연어 검색 — POST /api/search
```bash
curl -s localhost:9200/playlog-reviews-v2/_search -H 'Content-Type: application/json' -d '{
  "size": 100, "track_total_hits": false, "_source": ["gameId"],
  "collapse": { "field": "gameId" },
  "query": { "multi_match": { "query": "친구와 함께 힐링", "fields": ["text", "keywords^2"] } }
}'
```

### 확인용
```bash
curl -s localhost:9200/playlog-reviews-v2/_count            # = MySQL REVIEW 행 수
curl -s localhost:9200/playlog-reviews-v2/_mapping?pretty
curl -s 'localhost:9200/_cat/indices?v'
curl -X DELETE localhost:9200/playlog-reviews-v2            # 인덱스 삭제 (재색인 전)
```

---

## 4. Redis — Valkey (192.168.56.31:6379)

화면 API 결과 캐시. 키 = `playlog:<화면>:v2:<요청 값의 SHA-256>` · 값 = 결과 JSON · 만료(TTL) 30초 ~ 1시간.

```bash
valkey-cli -a '<VALKEY_PASSWORD>' --no-auth-warning
```
```text
KEYS playlog:*                      # 캐시된 키 목록 (운영에서는 SCAN 권장)
SCAN 0 MATCH playlog:a-wordcloud:* COUNT 100
GET  playlog:a-wordcloud:v2:<hash>  # 저장된 결과 JSON
TTL  playlog:a-wordcloud:v2:<hash>  # 남은 초
INFO keyspace                       # 키 개수
FLUSHDB                             # 캐시 비우기 (데이터 다시 만든 뒤)
```
앱 코드: `GET key` → 있으면 바로 응답, 없으면 MySQL/ES 조회 후 `SET key value EX <ttl>` (`backend/src/services/ratings-cache.js`).

---

## 5. Kafka (192.168.56.31:9092)

```bash
cd /opt/kafka/bin
./kafka-topics.sh --bootstrap-server localhost:9092 --create --topic steam.reviews --partitions 2 --replication-factor 1
./kafka-topics.sh --bootstrap-server localhost:9092 --list
./kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic steam.reviews
./kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group playlog-reviews-db-v3   # LAG 0 = 저장 완료
./kafka-console-consumer.sh --bootstrap-server localhost:9092 --topic steam.reviews --from-beginning --max-messages 1   # 메시지 하나 보기
```
메시지 1개 = `{ "appid": 413150, "review": { /* GetAppReviews 리뷰 1건 */ } }` · 키 = 리뷰 번호(recommendationid) · `acks: -1`(모든 복제본 기록 후 응답)로 발행.

---

## 6. 성능 확인 쿼리 (EXPLAIN)

```sql
-- 인덱스를 타는지: type이 ALL이면 전체 스캔, ref · range면 인덱스 사용
EXPLAIN SELECT COUNT(*) FROM REVIEW WHERE appid = 413150 AND voted_up = 1;
EXPLAIN SELECT COUNT(*) FROM REVIEW IGNORE INDEX (idx_review_vote, uk_review_author_game, idx_review_play)
        WHERE appid = 413150 AND voted_up = 1;                     -- 인덱스 없을 때 재현

-- 실제 실행 계획 + 시간 (MySQL 8)
EXPLAIN ANALYZE SELECT k.word, SUM(gk.review_cnt) c FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id)
                WHERE gk.appid = 413150 AND gk.voted_up = 1 GROUP BY k.word ORDER BY c DESC LIMIT 10;

-- 인덱스 목록
SHOW INDEX FROM REVIEW;
```

측정 결과 (로컬 MariaDB 10.11 · 가짜 데이터 · 30회 중앙값, 재현 방법은 [`backend/db/perf/`](../backend/db/perf/README.md)):

| 비교 | 없을 때 / 흔한 방식 | 있을 때 / 바꾼 방식 |
|---|---|---|
| 추천 리뷰 수 · `idx_review_vote` | ALL 7,457행 · 1.36 ms (10배 데이터: 10.34 ms) | ref 125행 · 0.13 ms (0.35 ms) |
| 플레이 시간대 · `idx_review_play` | ALL 7,457행 · 1.17 ms (11.08 ms) | range · 0.11 ms (0.16 ms) |
| 상위 키워드 정렬 · `idx_gk_rank` | filesort · 0.34 ms (1.56 ms) | 정렬 없음 · 0.14 ms (0.18 ms) |
| 게임별 통계 (E-3) | JOIN 후 집계: 14,284 ms · 값이 틀림 | 집계 후 JOIN: 9 ms · 정확 |
| 키워드 비율 (C-5) | 3중 JOIN 실시간 집계: 1.71 ms (16.0 ms) | GAME_KEYWORD: 0.95 ms (8.0 ms) |
| 페이지 넘기기 (B-2) | OFFSET 70000: 10.4 ms | 키셋 `review_id > ?`: 0.63 ms |
