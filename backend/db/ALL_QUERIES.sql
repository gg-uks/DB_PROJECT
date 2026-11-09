-- =====================================================================
--  PLAYLOG 전체 쿼리 정리 (발표 · 설명용, 실제 코드에서 쓰는 SQL 그대로)
--
--  읽는 법
--    · 순서: [A] 수집 → [B] 가공 → [C] 웹 조회 → [D] 회원 · 찜 → [E] 관리자
--    · 각 쿼리 위 주석: 어디서 쓰는지(파일 · API) / 무엇을 하는지 / 설계 포인트
--    · ?  = 코드(Node mysql2)가 값을 채우는 자리 (SQL 인젝션 방지용 바인딩)
--
--  Workbench에서 실행하기
--    · 파일 전체를 ⚡로 실행해도 데이터는 바뀌지 않습니다.
--      INSERT · UPDATE · DELETE는 /* … */ 안에 넣어 실행되지 않게 했고,
--      SELECT는 ? 대신 아래 @변수를 넣어 바로 돌아가게 했습니다.
-- =====================================================================
USE steam;

SET @appid    = (SELECT appid FROM GAME ORDER BY rank_no IS NULL, rank_no, appid LIMIT 1);
SET @genre    = (SELECT ge.name FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id
                 GROUP BY ge.genre_id, ge.name ORDER BY COUNT(*) DESC LIMIT 1);
SET @category = (SELECT c.name FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id
                 GROUP BY c.category_id, c.name ORDER BY COUNT(*) DESC LIMIT 1);
SET @member   = (SELECT member_id FROM MEMBER ORDER BY member_id LIMIT 1);
SET @email    = (SELECT email FROM MEMBER WHERE member_id = @member);

SELECT @appid AS 예시_appid, (SELECT name FROM GAME WHERE appid = @appid) AS 예시_게임,
       @genre AS 예시_장르, @category AS 예시_카테고리, @member AS 예시_회원;


-- #####################################################################
--  [A] 수집 — Steam API → MySQL (scripts/*.mjs, 매일 scheduler가 실행)
-- #####################################################################

-- A-1. 게임 상세 저장 (UPSERT)
--   파일: scripts/collect-game-details.mjs · 매일 03:00
--   · appdetails 응답 1개 = GAME 1행. 이미 있으면 최신값으로 덮어씀 (가격 · 순위는 이력 없이 최신값만 — v2 설계)
--   · ON DUPLICATE KEY UPDATE: PK(appid)가 이미 있으면 INSERT 대신 UPDATE → 한 문장으로 "없으면 넣고 있으면 고침"
--   · COALESCE(VALUES(x), x): 이번에 값을 못 받았으면(NULL) 예전 값을 유지
--   · 트랜잭션(BEGIN ~ COMMIT)으로 GAME · 장르 · 카테고리 · 회사를 한꺼번에 저장 (중간에 실패하면 ROLLBACK)
/*
INSERT INTO GAME (appid, name, is_free, required_age, release_date, coming_soon, metacritic, header_image,
                  recommendations_total, ko_review_score, ko_positive, ko_negative,
                  initial_price, final_price, currency)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  name = VALUES(name), is_free = VALUES(is_free), required_age = VALUES(required_age),
  release_date = VALUES(release_date), coming_soon = VALUES(coming_soon), metacritic = VALUES(metacritic),
  header_image = VALUES(header_image), recommendations_total = VALUES(recommendations_total),
  ko_review_score = COALESCE(VALUES(ko_review_score), ko_review_score),
  ko_positive = IF(? IS NULL, ko_positive, VALUES(ko_positive)),     -- 한국어 리뷰 요약을 못 받았으면 유지
  ko_negative = IF(? IS NULL, ko_negative, VALUES(ko_negative)),
  initial_price = VALUES(initial_price), final_price = VALUES(final_price), currency = VALUES(currency);
*/

-- A-2. 개발사 · 배급사 (다대다 + 역할)
--   · COMPANY는 이름이 UNIQUE → INSERT IGNORE로 처음 보는 회사만 추가
--   · GAME_COMPANY(appid, company_id, role): 같은 회사가 개발 · 배급 둘 다일 수 있어 role까지 PK
--   · 게임마다 연결을 지우고 다시 넣음 → 스팀에서 바뀐 내용이 그대로 반영
/*
DELETE FROM GAME_COMPANY WHERE appid = ?;
INSERT IGNORE INTO COMPANY (name) VALUES (?);
SELECT company_id FROM COMPANY WHERE name = ?;
INSERT IGNORE INTO GAME_COMPANY (appid, company_id, role) VALUES (?, ?, ?);   -- role: 'developer' | 'publisher'
*/

-- A-3. 장르 · 카테고리 (다대다)
--   · 스팀이 주는 번호(genres[].id, categories[].id)를 그대로 PK로 사용 (대리키 불필요)
--   · 이름이 바뀌면 ON DUPLICATE KEY UPDATE로 갱신
/*
DELETE FROM GAME_GENRE WHERE appid = ?;
INSERT INTO GENRE (genre_id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name);
INSERT IGNORE INTO GAME_GENRE (appid, genre_id) VALUES (?, ?);

DELETE FROM GAME_CATEGORY WHERE appid = ?;
INSERT INTO CATEGORY (category_id, name) VALUES (?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name);
INSERT IGNORE INTO GAME_CATEGORY (appid, category_id) VALUES (?, ?);
*/

-- A-4. 주간 순위 갱신
--   파일: scripts/collect-ranks.mjs · 매일 05:00
--   · 상위 100 안에 없는 게임은 NULL로 (순위 밖)
/*
UPDATE GAME SET rank_date = ?, rank_no = ?, last_week_rank = ?, peak_in_game = ? WHERE appid = ?;
*/
SELECT appid FROM GAME;                                   -- 갱신할 게임 목록

-- A-5. 리뷰 수집 시작점 — "이미 저장한 가장 최근 리뷰" (새 리뷰만 받기 · 요구사항 18)
--   파일: scripts/steam-reviews.mjs (produce)
--   · 게임마다 추천 · 비추천 각각의 MAX(created_at)보다 새 리뷰만 Kafka로 보냄
--   · LEFT JOIN: 리뷰가 하나도 없는 게임도 나와야 해서 (그때는 NULL → 처음부터 수집)
SELECT g.appid, g.name,
       MAX(CASE WHEN r.voted_up = 1 THEN r.created_at END) AS last_pos,
       MAX(CASE WHEN r.voted_up = 0 THEN r.created_at END) AS last_neg
FROM GAME g LEFT JOIN REVIEW r ON r.appid = g.appid
GROUP BY g.appid, g.name
ORDER BY g.appid;

-- A-6. 리뷰 저장 (Kafka consumer)
--   파일: scripts/steam-reviews.mjs (consume → saveReview)
--   순서: ① MongoDB review_text에 원문 저장 → _id 받기 → ② MySQL REVIEW에 정형 데이터 + mongo_id
--   · UNIQUE(appid, steamid): 한 사람은 게임당 리뷰 1개 → 같은 작성자가 지우고 다시 쓰면 예전 리뷰 먼저 삭제
--   · 리뷰가 수정됐으면(updated_at 변경) 그 리뷰의 키워드를 지워서 다시 추출되게 함
/*
SELECT review_id, mongo_id FROM REVIEW WHERE appid = ? AND steamid = ? AND review_id <> ?;   -- 같은 작성자의 예전 리뷰
DELETE FROM REVIEW WHERE review_id = ?;
SELECT updated_at FROM REVIEW WHERE review_id = ?;
DELETE FROM REVIEW_KEYWORD WHERE review_id = ?;                                             -- 수정된 리뷰면

INSERT INTO REVIEW (review_id, appid, steamid, language, voted_up, created_at, updated_at,
                    votes_up, votes_funny, steam_purchase, received_for_free, early_access,
                    playtime_at_review, playtime_forever, last_played, mongo_id)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  voted_up = VALUES(voted_up), updated_at = VALUES(updated_at), votes_up = VALUES(votes_up),
  votes_funny = VALUES(votes_funny), playtime_at_review = VALUES(playtime_at_review),
  playtime_forever = VALUES(playtime_forever), last_played = VALUES(last_played), mongo_id = VALUES(mongo_id);
*/

-- A-7. Steam API 호출 기록 (모든 호출마다 자동)
--   파일: src/services/api-log.js
--   · appid에 FK를 걸지 않음 → GAME에 아직 없는 게임(후보 고르기 중)이나 실패한 호출도 남김
--   · 연결 자체가 실패하면 status_code = 0 + error_msg
/*
INSERT INTO API_SYNC_LOG (api, appid, status_code, item_count, error_msg) VALUES (?, ?, ?, ?, ?);
*/


-- #####################################################################
--  [B] 가공 — 표본 정리 · 키워드 추출 · 집계 (매일 04:30)
-- #####################################################################

-- B-1. 표본 정리: 게임 × (추천 / 비추천)마다 최신 125건만 남기기
--   파일: scripts/trim-reviews.mjs
--   · ROW_NUMBER() OVER (PARTITION BY …): 묶음마다 1, 2, 3 … 번호를 매기는 윈도 함수 (MySQL 8 이상)
--   · 번호가 125보다 큰 = 오래된 리뷰 → 삭제 대상 (MongoDB 원문도 mongo_id로 같이 삭제)
SELECT appid, voted_up, COUNT(*) AS 삭제_대상
FROM (
  SELECT appid, voted_up,
         ROW_NUMBER() OVER (PARTITION BY appid, voted_up ORDER BY created_at DESC, review_id DESC) AS rn
  FROM REVIEW
) ranked
WHERE rn > 125
GROUP BY appid, voted_up;
/*
DELETE FROM REVIEW WHERE review_id IN (?);      -- 위에서 찾은 review_id 목록 (500개씩)
*/

-- B-2. 키워드를 아직 안 뽑은 리뷰 찾기
--   파일: scripts/extract-keywords.mjs
--   · NOT EXISTS: REVIEW_KEYWORD에 한 줄도 없는 리뷰 = 아직 추출 안 함 → 새 리뷰만 처리
--   · review_id > ? ORDER BY review_id LIMIT 200: 키셋 페이지네이션 (OFFSET보다 빠름)
SELECT r.review_id, r.mongo_id
FROM REVIEW r
WHERE r.review_id > 0
  AND NOT EXISTS (SELECT 1 FROM REVIEW_KEYWORD rk WHERE rk.review_id = r.review_id)
ORDER BY r.review_id
LIMIT 200;

-- B-3. 키워드 저장 (nori 형태소 분석 결과)
--   · KEYWORD.word UNIQUE → INSERT IGNORE로 새 단어만 사전에 추가하고 번호를 다시 조회
--   · REVIEW_KEYWORD(review_id, keyword_id, tf): tf = 그 리뷰 안 등장 횟수
/*
INSERT IGNORE INTO KEYWORD (word) VALUES (?), (?), …;
SELECT keyword_id, word FROM KEYWORD WHERE word IN (?);
DELETE FROM REVIEW_KEYWORD WHERE review_id IN (?);
INSERT INTO REVIEW_KEYWORD (review_id, keyword_id, tf) VALUES (?, ?, ?), …
  ON DUPLICATE KEY UPDATE tf = tf + VALUES(tf);
*/

-- B-4. 게임별 키워드 집계 GAME_KEYWORD (의도적 반정규화)
--   파일: scripts/aggregate-keywords.mjs
--   · REVIEW_KEYWORD에서 언제든 계산할 수 있는 값이지만, 화면마다 수만 행을 GROUP BY 하지 않도록 매일 미리 집계
--   · 전부 지우고 INSERT … SELECT로 다시 만듦 (트랜잭션)
/*
DELETE FROM GAME_KEYWORD;
INSERT INTO GAME_KEYWORD (appid, keyword_id, voted_up, review_cnt)
SELECT r.appid, rk.keyword_id, r.voted_up, COUNT(*)
FROM REVIEW r JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
GROUP BY r.appid, rk.keyword_id, r.voted_up;
*/
-- 위 INSERT의 SELECT 부분만 (예시 게임 · 상위 15)
SELECT r.appid, k.word, IF(r.voted_up, '추천', '비추천') AS 구분, COUNT(*) AS review_cnt
FROM REVIEW r
JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
JOIN KEYWORD k ON k.keyword_id = rk.keyword_id
WHERE r.appid = @appid
GROUP BY r.appid, k.keyword_id, k.word, r.voted_up
ORDER BY review_cnt DESC
LIMIT 15;

-- 집계 결과 확인
SELECT COUNT(*) AS n, SUM(voted_up = 1) AS pos, SUM(voted_up = 0) AS neg FROM GAME_KEYWORD;


-- #####################################################################
--  [C] 웹 조회 — 화면이 부르는 API
-- #####################################################################

-- C-0. 뷰 V_GAME_SUMMARY (팀 설계 v2) — 계산되는 값은 저장하지 않고 뷰에서 계산 (3NF)
--   · discount_pct    = (정가 - 판매가) / 정가
--   · ko_positive_pct = 추천 / (추천 + 비추천)   · NULLIF로 0으로 나누기 방지
--   · last_review_at  = 그 게임 리뷰의 MAX(created_at) (상관 서브쿼리)
SELECT * FROM V_GAME_SUMMARY ORDER BY rank_no IS NULL, rank_no;

-- C-1. 메인 게임 카드 목록 — GET /api/games (src/repositories/storage.js · readSnapshot)
--   · 다대다(GAME ↔ GENRE · CATEGORY · COMPANY)를 상관 서브쿼리 + GROUP_CONCAT으로 한 줄에 모음
--   · 순위 변화: rank 컬럼이 UNSIGNED라 그냥 빼면 음수에서 오류 → CAST(… AS SIGNED)
SELECT g.appid, g.name, g.is_free, g.coming_soon, g.required_age, g.metacritic,
       g.initial_price, g.final_price, g.currency, g.ko_review_score, g.ko_positive, g.ko_negative,
       g.recommendations_total, g.rank_no, g.last_week_rank, g.peak_in_game,
       s.discount_pct, s.ko_positive_pct,
       CAST(g.last_week_rank AS SIGNED) - CAST(g.rank_no AS SIGNED) AS rank_change,
       DATE_FORMAT(g.release_date, '%Y-%m-%d') AS release_date,
       (SELECT GROUP_CONCAT(ge.name ORDER BY ge.genre_id SEPARATOR '|')
          FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id WHERE gg.appid = g.appid) AS genres,
       (SELECT GROUP_CONCAT(c.name ORDER BY c.category_id SEPARATOR '|')
          FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id WHERE gc.appid = g.appid) AS categories,
       (SELECT GROUP_CONCAT(co.name ORDER BY co.name SEPARATOR '|')
          FROM GAME_COMPANY gco JOIN COMPANY co ON co.company_id = gco.company_id
         WHERE gco.appid = g.appid AND gco.role = 'developer') AS developers,
       (SELECT GROUP_CONCAT(co.name ORDER BY co.name SEPARATOR '|')
          FROM GAME_COMPANY gco JOIN COMPANY co ON co.company_id = gco.company_id
         WHERE gco.appid = g.appid AND gco.role = 'publisher') AS publishers
FROM GAME g
JOIN V_GAME_SUMMARY s ON s.appid = g.appid
ORDER BY g.rank_no IS NULL, g.rank_no, g.appid;

-- C-2. 장르 탭 · 카테고리 · 정렬 — GET /api/analytics/games?genre=&category=&sort=
--   · 필터: WHERE appid IN (서브쿼리) — 연결 테이블로 "이 장르에 속한 게임"을 찾음
--   · 정렬: ORDER BY 컬럼 IS NULL, 컬럼 — 값이 없는(NULL) 게임은 맨 뒤로
--     (정렬 선택지 = rank · positive · reviews · discount · metacritic · release, 코드에서 화이트리스트로만 허용)
SELECT s.appid, s.name, s.is_free, s.final_price, s.discount_pct, s.ko_review_score, s.ko_positive_pct,
       s.rank_no, CAST(s.last_week_rank AS SIGNED) - CAST(s.rank_no AS SIGNED) AS rank_change, g.header_image
FROM V_GAME_SUMMARY s
JOIN GAME g ON g.appid = s.appid
WHERE s.appid IN (SELECT gg.appid FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id WHERE ge.name = @genre)
  AND s.appid IN (SELECT gc.appid FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id WHERE c.name = @category)
ORDER BY s.rank_no IS NULL, s.rank_no, s.name;
-- 다른 정렬 예: 할인율 높은 순
SELECT s.name, s.discount_pct, s.final_price
FROM V_GAME_SUMMARY s
ORDER BY s.discount_pct IS NULL, s.discount_pct DESC, s.rank_no IS NULL, s.rank_no;

-- C-3. 장르 · 카테고리 선택지 (게임 수) — GET /api/analytics/filters
SELECT ge.name, COUNT(*) AS games
FROM GAME_GENRE gg JOIN GENRE ge ON ge.genre_id = gg.genre_id
GROUP BY ge.genre_id, ge.name
ORDER BY games DESC, ge.name;

SELECT c.name, COUNT(*) AS games
FROM GAME_CATEGORY gc JOIN CATEGORY c ON c.category_id = gc.category_id
GROUP BY c.category_id, c.name
ORDER BY games DESC, c.name;

-- C-4. 게임 상세 — GET /api/analytics/games/:id/info
--   ① GAME + 뷰 (가격 · 할인 · 한국어 평가 · 순위)
SELECT g.appid, g.name, g.is_free, g.required_age, DATE_FORMAT(g.release_date, '%Y-%m-%d') AS release_date,
       g.coming_soon, g.metacritic, g.header_image, g.recommendations_total, g.currency,
       s.initial_price, s.final_price, s.discount_pct, s.ko_review_score, s.ko_positive, s.ko_negative,
       s.ko_positive_pct, DATE_FORMAT(g.rank_date, '%Y-%m-%d') AS rank_date, s.rank_no, s.last_week_rank,
       CAST(s.last_week_rank AS SIGNED) - CAST(s.rank_no AS SIGNED) AS rank_change,
       s.peak_in_game, s.last_review_at, DATE_FORMAT(g.updated_at, '%Y-%m-%d %H:%i') AS updated_at
FROM GAME g JOIN V_GAME_SUMMARY s USING (appid)
WHERE g.appid = @appid;
--   ② 장르 · 카테고리 · 회사 (연결 테이블 JOIN)
SELECT ge.name FROM GAME_GENRE gg JOIN GENRE ge USING (genre_id) WHERE gg.appid = @appid ORDER BY ge.name;
SELECT c.name FROM GAME_CATEGORY gc JOIN CATEGORY c USING (category_id) WHERE gc.appid = @appid ORDER BY c.name;
SELECT c.name, gc.role FROM GAME_COMPANY gc JOIN COMPANY c USING (company_id) WHERE gc.appid = @appid ORDER BY gc.role, c.name;
--   ③ 추천 vs 비추천 표본 비교표 — GROUP BY voted_up 한 번으로 두 줄
SELECT voted_up, COUNT(*) AS n,
       ROUND(AVG(playtime_at_review)) AS avg_at_review, ROUND(AVG(playtime_forever)) AS avg_forever,
       SUM(votes_up) AS votes_up, SUM(votes_funny) AS votes_funny,
       SUM(steam_purchase = 1) AS purchased, SUM(received_for_free = 1) AS free_copy,
       SUM(early_access = 1) AS early_access,
       DATE_FORMAT(MIN(created_at), '%Y-%m-%d') AS first_at, DATE_FORMAT(MAX(created_at), '%Y-%m-%d') AS last_at
FROM REVIEW
WHERE appid = @appid
GROUP BY voted_up;
--   · SUM(조건): MySQL에서 조건식은 1/0 → SUM하면 "조건에 맞는 행 수" (COUNT(CASE …)와 같은 효과)

-- C-5. 키워드 비율 (게임 비교 화면) — GET /api/analytics/games/:id/keywords?side=pos
--   · 분모(그쪽 리뷰 수)는 저장하지 않고 REVIEW에서 셈 (2NF 결정: GAME에 리뷰 수를 저장하면 중복)
SELECT COUNT(*) AS total FROM REVIEW r WHERE r.appid = @appid AND r.voted_up = 1;
SELECT k.word, SUM(gk.review_cnt) AS review_cnt
FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id)
WHERE gk.appid = @appid AND gk.voted_up = 1
GROUP BY k.word
ORDER BY review_cnt DESC, k.word
LIMIT 10;

-- C-6. 플레이 시간대별 키워드 — …/keywords?band=lt10 | mid | ge100
--   · 시간대마다 따로 저장하지 않고 REVIEW · REVIEW_KEYWORD에서 바로 계산 (lt10: 600분 미만)
SELECT COUNT(*) AS total FROM REVIEW r WHERE r.appid = @appid AND r.playtime_at_review < 600;
SELECT k.word, COUNT(*) AS review_cnt
FROM REVIEW r
JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
JOIN KEYWORD k ON k.keyword_id = rk.keyword_id
WHERE r.appid = @appid AND r.playtime_at_review < 600
GROUP BY k.word
ORDER BY review_cnt DESC, k.word
LIMIT 12;

-- C-7. 비슷한 게임 · 취향 추천 — GET …/similar · POST /api/recommendations
--   · 게임마다 "추천 리뷰 키워드 비율" 벡터를 SQL로 구하고, 코사인 유사도는 Node에서 계산
--   · 파생 테이블 t: 게임별 추천 리뷰 수(분모)
SELECT gk.appid, k.word, gk.review_cnt / t.total AS ratio
FROM GAME_KEYWORD gk
JOIN KEYWORD k USING (keyword_id)
JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW WHERE voted_up = 1 GROUP BY appid) t ON t.appid = gk.appid
WHERE gk.voted_up = 1
ORDER BY gk.appid, ratio DESC;

-- C-8. 키워드로 게임 찾기 — GET /api/analytics/search?q=친구,힐링&exclude=버그
--   · 원하는 단어가 "모두" 나온 게임: GROUP BY 후 HAVING COUNT(*) = 단어 수
--   · 제외 단어가 전체 리뷰의 3% 이상인 게임은 NOT IN 서브쿼리로 뺌
SELECT g.appid, g.name, SUM(gk.review_cnt / t.total) AS score,
       GROUP_CONCAT(CONCAT(k.word, ':', ROUND(gk.review_cnt * 100 / t.total)) ORDER BY gk.review_cnt DESC) AS reason
FROM GAME_KEYWORD gk
JOIN KEYWORD k USING (keyword_id)
JOIN GAME g ON g.appid = gk.appid
JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW WHERE voted_up = 1 GROUP BY appid) t ON t.appid = gk.appid
WHERE gk.voted_up = 1
  AND k.word IN ('친구', '힐링')
  AND gk.appid NOT IN (
        SELECT x.appid FROM GAME_KEYWORD x JOIN KEYWORD xk USING (keyword_id)
        JOIN (SELECT appid, COUNT(*) AS total FROM REVIEW GROUP BY appid) xt ON xt.appid = x.appid
        WHERE xk.word IN ('버그')
        GROUP BY x.appid, xt.total
        HAVING SUM(x.review_cnt) / xt.total >= 0.03)
GROUP BY g.appid, g.name, g.header_image
HAVING COUNT(*) = 2
ORDER BY score DESC
LIMIT 20;

-- C-9. 워드클라우드 (ES가 없을 때 대신 쓰는 SQL) — GET …/wordcloud?side=neg
SELECT k.word, SUM(gk.review_cnt) AS cnt
FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id)
WHERE gk.appid = @appid AND gk.voted_up = 0
GROUP BY k.word
ORDER BY cnt DESC, k.word
LIMIT 60;
--   (ES가 있으면 nori 분석 인덱스에 terms · significant_text 집계를 보냄 — SQL 아님)

-- C-10. 리뷰 목록 — GET /api/games/:id/reviews?sentiment=&playtime=&sort=&page=
--   · 정렬 = recent(created_at) · helpful(votes_up) · playtime(playtime_at_review), 10개씩 LIMIT/OFFSET
--   · 본문은 MySQL에 없음 → mongo_id로 MongoDB review_text에서 가져옴 (정형 · 비정형 분리)
SELECT COUNT(*) AS total FROM REVIEW WHERE appid = @appid AND voted_up = 1;
SELECT review_id, appid, language, voted_up, created_at, updated_at, votes_up, votes_funny,
       steam_purchase, received_for_free, early_access, playtime_at_review, playtime_forever, last_played, mongo_id
FROM REVIEW
WHERE appid = @appid AND voted_up = 1 AND (playtime_at_review >= 600)
ORDER BY votes_up DESC, created_at DESC, review_id DESC
LIMIT 10 OFFSET 0;
--   플레이 시간별 추천 · 비추천 표 (CASE로 구간을 만들고 그 별칭으로 GROUP BY)
SELECT CASE WHEN playtime_at_review IS NULL THEN 'unknown'
            WHEN playtime_at_review < 120 THEN 'under-2h'
            WHEN playtime_at_review < 600 THEN '2-to-10h'
            ELSE '10h-plus' END AS time_group,
       SUM(CASE WHEN voted_up = 1 THEN 1 ELSE 0 END) AS positive,
       SUM(CASE WHEN voted_up = 0 THEN 1 ELSE 0 END) AS negative
FROM REVIEW WHERE appid = @appid
GROUP BY time_group;

-- C-11. 평가 막대 (게임 비교) — GET /api/game-ratings?ids=
--   · 총계는 스팀 한국어 전체 집계(GAME.ko_*), 표본이 아님
SELECT appid, ko_positive, ko_negative FROM GAME WHERE appid IN (@appid);


-- #####################################################################
--  [D] 회원 · 찜 — /api/auth · /api/me
-- #####################################################################

-- D-1. 회원가입 — POST /api/auth/signup
--   · 비밀번호는 bcrypt 해시만 저장 (평문 저장 금지) · email UNIQUE → 중복이면 ER_DUP_ENTRY → 409
/*
INSERT INTO MEMBER (email, password_hash, nickname) VALUES (?, ?, ?);
*/

-- D-2. 로그인 — POST /api/auth/login
--   · 이메일로 해시를 찾고 bcrypt.compare로 비교 (DB는 비교하지 않음)
--   · 맞으면 무작위 토큰을 쿠키로 주고, DB에는 토큰의 SHA-256 해시만 저장 (토큰이 새도 DB로는 못 씀)
SELECT member_id, email, nickname, password_hash, DATE_FORMAT(created_at, '%Y-%m-%d') AS joined_at
FROM MEMBER WHERE email = @email LIMIT 1;
/*
INSERT INTO MEMBER_SESSION (token_hash, member_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 24 HOUR));
DELETE FROM MEMBER_SESSION WHERE expires_at < NOW();     -- 만료된 세션 정리
*/

-- D-3. 로그인 확인 (모든 회원 API 앞에서) — GET /api/auth/me
--   · 쿠키 토큰의 해시로 세션을 찾고, 만료 안 된 것만 (expires_at > NOW())
SELECT m.member_id AS id, m.email, m.nickname, DATE_FORMAT(m.created_at, '%Y-%m-%d') AS joinedAt
FROM MEMBER_SESSION s JOIN MEMBER m ON m.member_id = s.member_id
WHERE s.member_id = @member AND s.expires_at > NOW();      -- 실제 코드: WHERE s.token_hash = ?
/*
DELETE FROM MEMBER_SESSION WHERE token_hash = ?;          -- 로그아웃
*/

-- D-4. 찜 목록 — GET /api/me/wishlist
SELECT g.appid, g.name, g.header_image, w.added_at, s.final_price, s.discount_pct, s.is_free, s.ko_positive_pct
FROM WISHLIST w
JOIN GAME g ON g.appid = w.appid
JOIN V_GAME_SUMMARY s ON s.appid = g.appid
WHERE w.member_id = @member
ORDER BY w.added_at DESC;
--   찜 추가 · 삭제
--   · PK(member_id, appid) → 같은 게임 두 번 찜 불가. ON DUPLICATE KEY로 중복만 무시
--     (INSERT IGNORE는 FK 오류(없는 게임)까지 숨겨서 쓰지 않음)
/*
INSERT INTO WISHLIST (member_id, appid) VALUES (?, ?) ON DUPLICATE KEY UPDATE added_at = added_at;
DELETE FROM WISHLIST WHERE member_id = ? AND appid = ?;
*/

-- D-5. 마이페이지 요약 — GET /api/me/summary
--   · 찜 수 · 할인 중 · 총액(무료는 0) · 평균 긍정률을 한 번에
SELECT COUNT(*) AS wished,
       SUM(s.discount_pct > 0) AS on_sale,
       SUM(CASE WHEN s.is_free THEN 0 ELSE s.final_price END) AS total_price,
       SUM(CASE WHEN s.is_free THEN 0 ELSE COALESCE(s.initial_price, s.final_price) END) AS total_initial,
       ROUND(AVG(s.ko_positive_pct), 1) AS avg_positive
FROM WISHLIST w JOIN V_GAME_SUMMARY s ON s.appid = w.appid
WHERE w.member_id = @member;
--   찜한 게임의 장르 분포 (WISHLIST → GAME_GENRE → GENRE)
SELECT ge.name, COUNT(*) AS games
FROM WISHLIST w
JOIN GAME_GENRE gg ON gg.appid = w.appid
JOIN GENRE ge ON ge.genre_id = gg.genre_id
WHERE w.member_id = @member
GROUP BY ge.genre_id, ge.name
ORDER BY games DESC, ge.name
LIMIT 6;
--   가입 며칠째
SELECT DATE_FORMAT(created_at, '%Y-%m-%d') AS joined_at, DATEDIFF(CURDATE(), DATE(created_at)) + 1 AS days
FROM MEMBER WHERE member_id = @member;

-- D-6. 계정 설정 — PATCH /api/me/profile · POST /api/me/password · DELETE /api/me
--   · 비밀번호를 바꾸면 지금 쓰는 세션만 남기고 다른 기기의 로그인을 끊음
--   · 탈퇴: MEMBER만 지우면 WISHLIST · MEMBER_SESSION은 FK의 ON DELETE CASCADE로 자동 삭제
/*
UPDATE MEMBER SET nickname = ? WHERE member_id = ?;
SELECT password_hash FROM MEMBER WHERE member_id = ?;
UPDATE MEMBER SET password_hash = ? WHERE member_id = ?;
DELETE FROM MEMBER_SESSION WHERE member_id = ? AND token_hash <> ?;
DELETE FROM MEMBER WHERE member_id = ?;
*/


-- #####################################################################
--  [E] 관리자 — /api/admin/* (로그인 + .env ADMIN_EMAILS 회원만)
-- #####################################################################

-- E-1. 핵심 지표 — GET /api/admin/overview
--   · 스칼라 서브쿼리 여러 개를 한 SELECT에 → 왕복 한 번으로 지표를 모두 가져옴
SELECT
  (SELECT COUNT(*) FROM GAME) AS games,
  (SELECT COUNT(*) FROM REVIEW) AS reviews,
  (SELECT SUM(voted_up = 1) FROM REVIEW) AS review_pos,
  (SELECT SUM(voted_up = 0) FROM REVIEW) AS review_neg,
  (SELECT COUNT(*) FROM MEMBER WHERE created_at >= NOW() - INTERVAL 7 DAY) AS new_members_7d,
  (SELECT COUNT(*) FROM MEMBER_SESSION WHERE expires_at > NOW()) AS active_sessions,
  (SELECT COUNT(*) FROM API_SYNC_LOG WHERE req_at >= NOW() - INTERVAL 1 DAY) AS calls_24h,
  (SELECT COUNT(*) FROM API_SYNC_LOG
    WHERE req_at >= NOW() - INTERVAL 1 DAY AND status_code NOT BETWEEN 200 AND 299) AS failed_24h,
  (SELECT DATE_FORMAT(MAX(rank_date), '%Y-%m-%d') FROM GAME) AS rank_date,
  (SELECT DATE_FORMAT(MAX(updated_at), '%Y-%m-%d %H:%i') FROM GAME) AS game_updated_at,
  (SELECT DATE_FORMAT(MAX(created_at), '%Y-%m-%d %H:%i') FROM REVIEW) AS last_review_at;
--   API별 마지막 호출 (데이터 갱신 상태)
SELECT api, DATE_FORMAT(MAX(req_at), '%Y-%m-%d %H:%i') AS last_at FROM API_SYNC_LOG GROUP BY api ORDER BY api;
--   테이블별 행 수 (코드는 스칼라 서브쿼리로, 여기서는 보기 좋게 UNION ALL로)
SELECT 'GAME' AS tbl, COUNT(*) AS n FROM GAME
UNION ALL SELECT 'GENRE', COUNT(*) FROM GENRE
UNION ALL SELECT 'GAME_GENRE', COUNT(*) FROM GAME_GENRE
UNION ALL SELECT 'CATEGORY', COUNT(*) FROM CATEGORY
UNION ALL SELECT 'GAME_CATEGORY', COUNT(*) FROM GAME_CATEGORY
UNION ALL SELECT 'COMPANY', COUNT(*) FROM COMPANY
UNION ALL SELECT 'GAME_COMPANY', COUNT(*) FROM GAME_COMPANY
UNION ALL SELECT 'REVIEW', COUNT(*) FROM REVIEW
UNION ALL SELECT 'KEYWORD', COUNT(*) FROM KEYWORD
UNION ALL SELECT 'REVIEW_KEYWORD', COUNT(*) FROM REVIEW_KEYWORD
UNION ALL SELECT 'GAME_KEYWORD', COUNT(*) FROM GAME_KEYWORD
UNION ALL SELECT 'MEMBER', COUNT(*) FROM MEMBER
UNION ALL SELECT 'WISHLIST', COUNT(*) FROM WISHLIST
UNION ALL SELECT 'API_SYNC_LOG', COUNT(*) FROM API_SYNC_LOG
UNION ALL SELECT 'MEMBER_SESSION', COUNT(*) FROM MEMBER_SESSION;

-- E-2. 수집 현황 — GET /api/admin/api-log
--   API별 성공 · 실패 (status_code 200번대 = 성공)
SELECT api, COUNT(*) AS calls, SUM(status_code BETWEEN 200 AND 299) AS ok,
       SUM(status_code NOT BETWEEN 200 AND 299) AS failed, SUM(item_count) AS items,
       DATE_FORMAT(MAX(req_at), '%Y-%m-%d %H:%i') AS last_at
FROM API_SYNC_LOG GROUP BY api ORDER BY calls DESC;
--   일별 호출 (최근 14일)
--   · MySQL 8 ONLY_FULL_GROUP_BY: SELECT에 쓴 식과 GROUP BY 식이 같아야 함 → 별칭(day)으로 묶음
SELECT DATE_FORMAT(DATE(req_at), '%Y-%m-%d') AS day,
       SUM(status_code BETWEEN 200 AND 299) AS ok,
       SUM(status_code NOT BETWEEN 200 AND 299) AS failed,
       SUM(item_count) AS items
FROM API_SYNC_LOG
WHERE req_at >= CURDATE() - INTERVAL 13 DAY
GROUP BY day
ORDER BY day;
--   최근 실패 20건 (LEFT JOIN: 게임 이름이 없어도 기록은 보여야 함 — appid에 FK 없음)
SELECT l.log_id, l.api, l.appid, g.name, DATE_FORMAT(l.req_at, '%Y-%m-%d %H:%i:%s') AS req_at,
       l.status_code, l.error_msg
FROM API_SYNC_LOG l LEFT JOIN GAME g ON g.appid = l.appid
WHERE l.status_code NOT BETWEEN 200 AND 299
ORDER BY l.log_id DESC LIMIT 20;
--   최근 호출 30건
SELECT l.log_id, l.api, l.appid, g.name, DATE_FORMAT(l.req_at, '%m-%d %H:%i:%s') AS req_at,
       l.status_code, l.item_count
FROM API_SYNC_LOG l LEFT JOIN GAME g ON g.appid = l.appid
ORDER BY l.log_id DESC LIMIT 30;

-- E-3. 게임별 수집 상태 — GET /api/admin/games
--   · 테이블마다 먼저 GROUP BY로 집계한 파생 테이블을 만들고 GAME에 LEFT JOIN
--     (리뷰 · 키워드 · 찜이 없는 게임도 0으로 나와야 하므로 LEFT JOIN + COALESCE)
SELECT g.appid, g.name, g.ko_review_score, g.rank_no,
       COALESCE(r.pos, 0) AS pos, COALESCE(r.neg, 0) AS neg,
       DATE_FORMAT(r.last_at, '%Y-%m-%d') AS last_review_at,
       COALESCE(k.keyword_rows, 0) AS keyword_rows,
       COALESCE(w.wished, 0) AS wished,
       (SELECT COUNT(*) FROM GAME_GENRE gg WHERE gg.appid = g.appid) AS genres,
       (SELECT COUNT(*) FROM GAME_CATEGORY gc WHERE gc.appid = g.appid) AS categories
FROM GAME g
LEFT JOIN (SELECT appid, SUM(voted_up = 1) AS pos, SUM(voted_up = 0) AS neg, MAX(created_at) AS last_at
           FROM REVIEW GROUP BY appid) r ON r.appid = g.appid
LEFT JOIN (SELECT appid, COUNT(*) AS keyword_rows FROM GAME_KEYWORD GROUP BY appid) k ON k.appid = g.appid
LEFT JOIN (SELECT appid, COUNT(*) AS wished FROM WISHLIST GROUP BY appid) w ON w.appid = g.appid
ORDER BY g.rank_no IS NULL, g.rank_no, g.name;

-- E-4. 회원 — GET /api/admin/members
SELECT m.member_id, m.email, m.nickname, DATE_FORMAT(m.created_at, '%Y-%m-%d %H:%i') AS created_at,
       (SELECT COUNT(*) FROM WISHLIST w WHERE w.member_id = m.member_id) AS wished,
       (SELECT COUNT(*) FROM MEMBER_SESSION s WHERE s.member_id = m.member_id AND s.expires_at > NOW()) AS sessions
FROM MEMBER m
ORDER BY m.created_at DESC, m.member_id DESC
LIMIT 50;
--   최근 30일 가입 추이
SELECT DATE_FORMAT(DATE(created_at), '%Y-%m-%d') AS day, COUNT(*) AS members
FROM MEMBER
WHERE created_at >= CURDATE() - INTERVAL 29 DAY
GROUP BY day
ORDER BY day;
--   많이 찜한 게임
SELECT g.appid, g.name, COUNT(*) AS wished
FROM WISHLIST w JOIN GAME g ON g.appid = w.appid
GROUP BY g.appid, g.name
ORDER BY wished DESC, g.name
LIMIT 10;

-- E-5. 전체 상위 키워드 — GET /api/admin/keywords (추천 = 1 · 비추천 = 0)
SELECT k.word, SUM(gk.review_cnt) AS reviews, COUNT(DISTINCT gk.appid) AS games
FROM GAME_KEYWORD gk JOIN KEYWORD k ON k.keyword_id = gk.keyword_id
WHERE gk.voted_up = 1
GROUP BY k.keyword_id, k.word
ORDER BY reviews DESC, k.word
LIMIT 15;
