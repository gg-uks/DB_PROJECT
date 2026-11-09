# 화면별 SQL 정리 (발표 · 설명용)

> 이 파일은 **읽는 문서**입니다(마크다운 · `?` 자리표시자 포함). Workbench에서 직접 돌려 보려면
> 같은 폴더의 **`ALL_QUERIES.sql`** 을 여세요 — 프로젝트의 모든 쿼리가 주석과 함께 들어 있고,
> 전체 실행(⚡)해도 데이터가 바뀌지 않습니다.

화면에 보이는 숫자는 모두 MySQL 쿼리 결과입니다. 프론트(React)는 받은 값을 그대로 그리며,
점수 1~9 → "매우 긍정적" 같은 **문구 바꾸기 · 단위 바꾸기(분 → 시간) · 글자 크기**만 합니다.

| 화면 | API | 쓰는 테이블 · 뷰 |
|---|---|---|
| 게임 목록 (장르 탭 · 카테고리 · 정렬) | `GET /api/analytics/games` | V_GAME_SUMMARY · GAME · GAME_GENRE · GENRE · GAME_CATEGORY · CATEGORY |
| 장르 · 카테고리 목록 (게임 수) | `GET /api/analytics/filters` | GAME_GENRE · GENRE · GAME_CATEGORY · CATEGORY |
| 게임 카드 (가격 · 할인 · 긍정률 · 순위) | `GET /api/games` | GAME · V_GAME_SUMMARY · GAME_GENRE · GAME_CATEGORY · GAME_COMPANY |
| 게임 상세 정보 | `GET /api/analytics/games/:id/info` | GAME · V_GAME_SUMMARY · GENRE · CATEGORY · COMPANY · REVIEW |
| 추천 vs 비추천 비교표 | 〃 | REVIEW (GROUP BY voted_up) |
| 키워드 비율 (게임 비교) | `GET /api/analytics/games/:id/keywords` | GAME_KEYWORD · KEYWORD · REVIEW |
| 플레이 시간대별 키워드 | `…/keywords?band=lt10` | REVIEW · REVIEW_KEYWORD · KEYWORD |
| 비슷한 게임 · 취향 추천 | `…/similar` · `POST /api/recommendations` | GAME_KEYWORD · KEYWORD · REVIEW |
| 리뷰 목록 (정렬 · 필터 · 페이지) | `GET /api/games/:id/reviews` | REVIEW (+ MongoDB review_text 본문) |
| 플레이 시간별 추천 · 비추천 표 | 〃 | REVIEW (GROUP BY CASE) |
| 평가 막대 (게임 비교) | `GET /api/game-ratings` | GAME (ko_positive · ko_negative) |
| 워드클라우드 | `…/wordcloud` | Elasticsearch 집계 (ES가 없으면 GAME_KEYWORD) |
| 찜 목록 | `GET /api/me/wishlist` | WISHLIST · GAME · V_GAME_SUMMARY |
| 회원가입 · 로그인 | `/api/auth/*` | MEMBER · MEMBER_SESSION |

---

## 1. 게임 목록 — 장르 · 카테고리 필터 + 정렬

```sql
SELECT s.appid, s.name, s.final_price, s.discount_pct, s.ko_positive_pct, s.rank_no,
       CAST(s.last_week_rank AS SIGNED) - CAST(s.rank_no AS SIGNED) AS rank_change   -- 순위 변화 (+ 상승)
FROM V_GAME_SUMMARY s
JOIN GAME g ON g.appid = s.appid
WHERE s.appid IN (SELECT gg.appid FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id
                  WHERE ge.name = '액션')                                        -- 장르 탭
  AND s.appid IN (SELECT gc.appid FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id
                  WHERE c.name = '협동')                                         -- 카테고리 선택
ORDER BY s.rank_no IS NULL, s.rank_no;                                          -- 정렬
```

정렬 선택지별 `ORDER BY`

| 정렬 | ORDER BY |
|---|---|
| 주간 플레이 순위 | `s.rank_no IS NULL, s.rank_no` (순위 없는 게임은 뒤로) |
| 한국어 긍정률 | `s.ko_positive_pct IS NULL, s.ko_positive_pct DESC` |
| 한국어 리뷰 많은 순 | `(s.ko_positive + s.ko_negative) DESC` |
| 할인율 | `s.discount_pct IS NULL, s.discount_pct DESC` |
| 메타크리틱 | `g.metacritic IS NULL, g.metacritic DESC` |
| 최신 출시 | `g.release_date IS NULL, g.release_date DESC` |

- 순위 컬럼이 `UNSIGNED`라서 빼기 결과가 음수면 오류가 나므로 `CAST(… AS SIGNED)` 후 뺌
- 할인율 · 긍정률은 저장하지 않고 **뷰 V_GAME_SUMMARY가 계산** (3NF: 다른 컬럼에서 계산되는 값은 저장 안 함)

```sql
-- V_GAME_SUMMARY (팀 설계 v2)
CASE WHEN g.initial_price > 0
     THEN ROUND((g.initial_price - g.final_price) * 100 / g.initial_price) END AS discount_pct,
ROUND(g.ko_positive * 100 / NULLIF(g.ko_positive + g.ko_negative, 0), 1)    AS ko_positive_pct,
(SELECT MAX(r.created_at) FROM REVIEW r WHERE r.appid = g.appid)            AS last_review_at
```

## 2. 장르 · 카테고리 목록 (게임 수)

```sql
SELECT ge.name, COUNT(*) AS games
FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id
GROUP BY ge.genre_id, ge.name
ORDER BY games DESC, ge.name;
-- 카테고리도 같은 모양 (GAME_CATEGORY · CATEGORY)
```

## 3. 게임 카드 — 장르 · 카테고리 · 회사를 한 줄로

```sql
SELECT g.appid, g.name, g.metacritic, g.release_date, s.discount_pct, s.ko_positive_pct,
       (SELECT GROUP_CONCAT(ge.name ORDER BY ge.genre_id SEPARATOR '|')
          FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id
         WHERE gg.appid = g.appid) AS genres,
       (SELECT GROUP_CONCAT(co.name SEPARATOR '|')
          FROM GAME_COMPANY gco JOIN COMPANY co ON co.company_id = gco.company_id
         WHERE gco.appid = g.appid AND gco.role = 'developer') AS developers
FROM GAME g JOIN V_GAME_SUMMARY s ON s.appid = g.appid;
```
- 다대다(GAME ↔ GENRE)를 연결 테이블로 풀고, 화면용으로 `GROUP_CONCAT`으로 다시 묶음
- 같은 COMPANY가 개발 · 배급 둘 다일 수 있어 `GAME_COMPANY.role`로 구분

## 4. 게임 상세 — 추천 vs 비추천 표본 비교

```sql
SELECT voted_up, COUNT(*) AS n,
       ROUND(AVG(playtime_at_review)) AS avg_at_review,   -- 작성 당시 평균 플레이(분)
       ROUND(AVG(playtime_forever))   AS avg_forever,     -- 수집 시점 총 플레이(분)
       SUM(votes_up) AS votes_up, SUM(votes_funny) AS votes_funny,
       SUM(steam_purchase = 1) AS purchased, SUM(received_for_free = 1) AS free_copy,
       SUM(early_access = 1) AS early_access,
       MIN(created_at) AS first_at, MAX(created_at) AS last_at
FROM REVIEW
WHERE appid = ?
GROUP BY voted_up;
```

## 5. 키워드 비율 — 분모는 저장하지 않고 REVIEW에서 셈

```sql
-- 분모: 그 게임의 추천 리뷰 수
SELECT COUNT(*) AS total FROM REVIEW r WHERE r.appid = ? AND r.voted_up = 1;

-- 분자: 키워드별 리뷰 수 (매일 집계해 둔 GAME_KEYWORD · 의도적 반정규화)
SELECT k.word, SUM(gk.review_cnt) AS review_cnt
FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id)
WHERE gk.appid = ? AND gk.voted_up = 1
GROUP BY k.word
ORDER BY review_cnt DESC, k.word
LIMIT 10;
```
GAME_KEYWORD는 아래 쿼리로 매일 다시 만듦 (`npm run keywords:aggregate`)
```sql
INSERT INTO GAME_KEYWORD (appid, keyword_id, voted_up, review_cnt)
SELECT r.appid, rk.keyword_id, r.voted_up, COUNT(*)
FROM REVIEW r JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
GROUP BY r.appid, rk.keyword_id, r.voted_up;
```

## 6. 플레이 시간대별 키워드 — 저장 없이 바로 계산

```sql
SELECT k.word, COUNT(*) AS review_cnt
FROM REVIEW r
JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
JOIN KEYWORD k ON k.keyword_id = rk.keyword_id
WHERE r.appid = ?
  AND r.playtime_at_review < 600            -- 10시간 미만 (10~100시간: >= 600 AND < 6000 · 100시간 이상: >= 6000)
GROUP BY k.word
ORDER BY review_cnt DESC, k.word
LIMIT 12;
```

## 7. 비슷한 게임 · 취향 추천 — 키워드 비율 벡터

```sql
SELECT gk.appid, k.word, gk.review_cnt / t.total AS ratio
FROM GAME_KEYWORD gk
JOIN KEYWORD k USING (keyword_id)
JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW WHERE voted_up = 1 GROUP BY appid) t ON t.appid = gk.appid
WHERE gk.voted_up = 1
ORDER BY gk.appid, ratio DESC;
```
- 게임마다 상위 30개 키워드 비율을 벡터로 보고, 두 게임의 **코사인 유사도**는 Node에서 계산
  (게임이 30개라 30 × 30번 비교 · SQL로 하면 자기 조인이 커져서 애플리케이션에서 처리)

## 8. 리뷰 목록 — 정렬 · 필터 · 페이지

```sql
SELECT review_id, voted_up, created_at, updated_at, votes_up, votes_funny, steam_purchase,
       received_for_free, early_access, playtime_at_review, playtime_forever, last_played, mongo_id
FROM REVIEW
WHERE appid = ? AND voted_up = 1                                  -- 평가 필터
  AND playtime_at_review >= 600                                   -- 플레이 시간 필터
ORDER BY votes_up DESC, created_at DESC, review_id DESC           -- 정렬: 도움이 돼요 많은 순
LIMIT 10 OFFSET 0;                                                -- 페이지
```
- 본문은 MySQL에 없고 `mongo_id`로 MongoDB `review_text`에서 가져옴 (정형 · 비정형 분리)

플레이 시간별 추천 · 비추천 표
```sql
SELECT CASE WHEN playtime_at_review IS NULL THEN 'unknown'
            WHEN playtime_at_review < 120 THEN 'under-2h'
            WHEN playtime_at_review < 600 THEN '2-to-10h'
            ELSE '10h-plus' END AS time_group,
       SUM(voted_up = 1) AS positive, SUM(voted_up = 0) AS negative
FROM REVIEW WHERE appid = ?
GROUP BY time_group;
```

## 9. 찜 목록

```sql
SELECT g.appid, g.name, w.added_at, s.final_price, s.discount_pct, s.ko_positive_pct
FROM WISHLIST w
JOIN GAME g ON g.appid = w.appid
JOIN V_GAME_SUMMARY s ON s.appid = g.appid
WHERE w.member_id = ?
ORDER BY w.added_at DESC;

INSERT INTO WISHLIST (member_id, appid) VALUES (?, ?)
  ON DUPLICATE KEY UPDATE added_at = added_at;     -- 이미 찜했으면 그대로 (PK = member_id, appid)
DELETE FROM WISHLIST WHERE member_id = ? AND appid = ?;
```

## 10. 관리자 페이지 — `GET /api/admin/api-log` (관리자만)

```sql
SELECT api, COUNT(*) AS calls,
       SUM(status_code BETWEEN 200 AND 299) AS ok,
       SUM(status_code NOT BETWEEN 200 AND 299) AS failed,
       SUM(item_count) AS items, MAX(req_at) AS last_at
FROM API_SYNC_LOG
GROUP BY api;
```
