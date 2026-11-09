-- =====================================================================
--  스팀 게임 리뷰 키워드 분석 플랫폼 · MySQL 8.0 스키마 v2 (3NF, 14개 테이블)
--  근거 문서 : 정규화 설계서 (요구사항 → E/R/A → 1NF → 2NF → 3NF)
--  실행 위치 : MySQL Source (192.168.0.21) → Replica(.23)는 binlog로 자동 복제
--  실행 방법 : mysql -u root -p < steam_review_schema_v2.sql
--
--  v1 대비 변경
--   - CATEGORY / GAME_CATEGORY 추가 (싱글·멀티·협동 필터)
--   - PRICE_HISTORY / PLAYER_COUNT / SYNC_STATE 제거 → 가격·순위는 GAME에 최신값만
--   - 할인율·표본 구분·마지막 리뷰/수집 시각 제거 (3NF: 계산 가능한 값)
--   - REVIEW에 steamid · 누적 플레이 시간 추가, (appid, steamid) UNIQUE
--   - REVIEW.is_short 제거 (3어절 미만은 수집 단계에서 제외)
--
--  구성 : 0. DB  1. 게임과 분류  2. 리뷰·키워드  3. 회원  4. 수집 로그
--         5. 뷰   6. 샘플 데이터   7. 확인 쿼리
-- =====================================================================

-- ---------------------------------------------------------------------
-- 0. 데이터베이스 (utf8mb4: 한국어 + 리뷰 속 이모지)
-- ---------------------------------------------------------------------
DROP DATABASE IF EXISTS steam;
CREATE DATABASE steam
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;
USE steam;

-- ---------------------------------------------------------------------
-- 1. 게임과 분류
-- ---------------------------------------------------------------------

-- 1행 = 게임 1개. 가격·순위는 최신값만 덮어씀 (이력 없음)
CREATE TABLE GAME (
  appid                 INT UNSIGNED      NOT NULL,                -- steam_appid
  name                  VARCHAR(255)      NOT NULL,                -- name
  is_free               BOOLEAN           NOT NULL DEFAULT FALSE,  -- is_free
  required_age          TINYINT UNSIGNED  NOT NULL DEFAULT 0,      -- required_age
  release_date          DATE              NULL,                    -- release_date.date ("2016년 2월 27일" → DATE), 출시 예정작 NULL
  coming_soon           BOOLEAN           NOT NULL DEFAULT FALSE,  -- release_date.coming_soon
  metacritic            TINYINT UNSIGNED  NULL,                    -- metacritic.score (없는 게임 많음)
  header_image          VARCHAR(500)      NULL,                    -- header_image (파일은 GridFS)
  recommendations_total INT UNSIGNED      NULL,                    -- recommendations.total (전체 언어)
  ko_review_score       TINYINT UNSIGNED  NULL,                    -- GetAppReviews query_summary.review_score (한국어 기준 1~9)
  ko_positive           INT UNSIGNED      NOT NULL DEFAULT 0,      -- query_summary.total_positive (스팀 전체 집계, 표본 아님)
  ko_negative           INT UNSIGNED      NOT NULL DEFAULT 0,      -- query_summary.total_negative
  initial_price         INT UNSIGNED      NULL,                    -- price_overview.initial ÷ 100 (원), 무료면 NULL
  final_price           INT UNSIGNED      NULL,                    -- price_overview.final ÷ 100 (원)
  currency              CHAR(3)           NULL,                    -- price_overview.currency
  rank_date             DATE              NULL,                    -- GetMostPlayedGames rollup_date
  rank_no               SMALLINT UNSIGNED NULL,                    -- ranks[].rank   (RANK는 MySQL 8 예약어라 rank_no)
  last_week_rank        SMALLINT UNSIGNED NULL,                    -- ranks[].last_week_rank (-1 → NULL)
  peak_in_game          INT UNSIGNED      NULL,                    -- ranks[].peak_in_game (주간 최고 동시 접속자)
  updated_at            DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP
                                          ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (appid),
  KEY idx_game_name (name),
  CONSTRAINT chk_game_score CHECK (ko_review_score IS NULL OR ko_review_score BETWEEN 1 AND 9),
  CONSTRAINT chk_game_price CHECK (final_price IS NULL OR initial_price IS NULL OR final_price <= initial_price)
) ENGINE=InnoDB;

-- 장르 : genres[].id 를 그대로 PK ("23" → 23)
CREATE TABLE GENRE (
  genre_id INT          NOT NULL,     -- genres[].id
  name     VARCHAR(50)  NOT NULL,     -- genres[].description
  PRIMARY KEY (genre_id)
) ENGINE=InnoDB;

CREATE TABLE GAME_GENRE (
  appid    INT UNSIGNED NOT NULL,
  genre_id INT          NOT NULL,
  PRIMARY KEY (appid, genre_id),
  KEY idx_gg_genre (genre_id),
  CONSTRAINT fk_gg_game  FOREIGN KEY (appid)    REFERENCES GAME(appid)  ON DELETE CASCADE,
  CONSTRAINT fk_gg_genre FOREIGN KEY (genre_id) REFERENCES GENRE(genre_id)
) ENGINE=InnoDB;

-- 카테고리 : categories[].id (싱글 플레이어 2, 멀티플레이어 1, 협동 9 …)
CREATE TABLE CATEGORY (
  category_id INT          NOT NULL,  -- categories[].id
  name        VARCHAR(100) NOT NULL,  -- categories[].description
  PRIMARY KEY (category_id)
) ENGINE=InnoDB;

CREATE TABLE GAME_CATEGORY (
  appid       INT UNSIGNED NOT NULL,
  category_id INT          NOT NULL,
  PRIMARY KEY (appid, category_id),
  KEY idx_gc_category (category_id),
  CONSTRAINT fk_gcat_game     FOREIGN KEY (appid)       REFERENCES GAME(appid)          ON DELETE CASCADE,
  CONSTRAINT fk_gcat_category FOREIGN KEY (category_id) REFERENCES CATEGORY(category_id)
) ENGINE=InnoDB;

-- 회사 : 스팀이 번호를 주지 않아 대리키 + 이름 UNIQUE
CREATE TABLE COMPANY (
  company_id INT          NOT NULL AUTO_INCREMENT,
  name       VARCHAR(150) NOT NULL,   -- developers[] / publishers[]
  PRIMARY KEY (company_id),
  UNIQUE KEY uk_company_name (name)
) ENGINE=InnoDB;

-- 역할은 회사가 아니라 관계의 속성
CREATE TABLE GAME_COMPANY (
  appid      INT UNSIGNED                  NOT NULL,
  company_id INT                           NOT NULL,
  role       ENUM('developer','publisher') NOT NULL,  -- developers[] → developer, publishers[] → publisher
  PRIMARY KEY (appid, company_id, role),
  KEY idx_gco_company (company_id),
  CONSTRAINT fk_gco_game    FOREIGN KEY (appid)      REFERENCES GAME(appid)          ON DELETE CASCADE,
  CONSTRAINT fk_gco_company FOREIGN KEY (company_id) REFERENCES COMPANY(company_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 2. 리뷰 · 키워드 (본문은 MongoDB review_text, 여기엔 메타데이터만)
-- ---------------------------------------------------------------------

-- 1행 = 리뷰 1건. 게임당 추천 125 + 비추천 125 (층화 표본)
CREATE TABLE REVIEW (
  review_id          BIGINT UNSIGNED NOT NULL,              -- recommendationid
  appid              INT UNSIGNED    NOT NULL,              -- 요청한 appid
  steamid            BIGINT UNSIGNED NOT NULL,              -- author.steamid (목록 표시용)
  language           VARCHAR(20)     NOT NULL,              -- language
  voted_up           BOOLEAN         NOT NULL,              -- voted_up (= 표본 구분)
  created_at         DATETIME        NOT NULL,              -- timestamp_created (unix → KST)
  updated_at         DATETIME        NOT NULL,              -- timestamp_updated
  votes_up           INT UNSIGNED    NOT NULL DEFAULT 0,    -- votes_up
  votes_funny        INT UNSIGNED    NOT NULL DEFAULT 0,    -- votes_funny
  steam_purchase     BOOLEAN         NOT NULL DEFAULT TRUE, -- steam_purchase
  received_for_free  BOOLEAN         NOT NULL DEFAULT FALSE,-- received_for_free
  early_access       BOOLEAN         NOT NULL DEFAULT FALSE,-- written_during_early_access
  playtime_at_review INT UNSIGNED    NULL,                  -- author.playtime_at_review (분)
  playtime_forever   INT UNSIGNED    NULL,                  -- author.playtime_forever (분, 수집 시점)
  last_played        DATETIME        NULL,                  -- author.last_played
  mongo_id           CHAR(24)        NOT NULL,              -- MongoDB review_text._id
  PRIMARY KEY (review_id),
  UNIQUE KEY uk_review_author_game (appid, steamid),        -- 한 유저는 한 게임에 리뷰 1개 (후보키)
  UNIQUE KEY uk_review_mongo (mongo_id),
  KEY idx_review_vote (appid, voted_up),                    -- 추천 vs 비추천
  KEY idx_review_play (appid, playtime_at_review),          -- 플레이 시간대별
  CONSTRAINT fk_review_game FOREIGN KEY (appid) REFERENCES GAME(appid) ON DELETE CASCADE
) ENGINE=InnoDB;

-- 단어 사전 : 같은 단어는 1행 (nori 명사)
CREATE TABLE KEYWORD (
  keyword_id INT         NOT NULL AUTO_INCREMENT,
  word       VARCHAR(50) NOT NULL,
  PRIMARY KEY (keyword_id),
  UNIQUE KEY uk_keyword_word (word)
) ENGINE=InnoDB;

-- 리뷰-키워드 N:M
CREATE TABLE REVIEW_KEYWORD (
  review_id  BIGINT UNSIGNED   NOT NULL,
  keyword_id INT               NOT NULL,
  tf         SMALLINT UNSIGNED NOT NULL DEFAULT 1,   -- 리뷰 안 등장 횟수
  PRIMARY KEY (review_id, keyword_id),
  KEY idx_rk_keyword (keyword_id),
  CONSTRAINT fk_rk_review  FOREIGN KEY (review_id)  REFERENCES REVIEW(review_id)   ON DELETE CASCADE,
  CONSTRAINT fk_rk_keyword FOREIGN KEY (keyword_id) REFERENCES KEYWORD(keyword_id)
) ENGINE=InnoDB;

-- [의도적 반정규화] REVIEW + REVIEW_KEYWORD 로 계산 가능한 집계. 수집 후 7-③으로 재계산
CREATE TABLE GAME_KEYWORD (
  appid      INT UNSIGNED NOT NULL,
  keyword_id INT          NOT NULL,
  voted_up   BOOLEAN      NOT NULL,
  review_cnt INT UNSIGNED NOT NULL,                   -- 이 단어가 나온 리뷰 수
  PRIMARY KEY (appid, keyword_id, voted_up),
  KEY idx_gk_rank (appid, voted_up, review_cnt),
  CONSTRAINT fk_gk_game    FOREIGN KEY (appid)      REFERENCES GAME(appid)       ON DELETE CASCADE,
  CONSTRAINT fk_gk_keyword FOREIGN KEY (keyword_id) REFERENCES KEYWORD(keyword_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 3. 회원 (우리 서비스에서 생기는 데이터 → 백업 필수)
-- ---------------------------------------------------------------------
CREATE TABLE MEMBER (
  member_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  email         VARCHAR(100)    NOT NULL,
  password_hash VARCHAR(255)    NOT NULL,             -- bcrypt 해시 (평문 저장 금지)
  nickname      VARCHAR(30)     NOT NULL,
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id),
  UNIQUE KEY uk_member_email (email)
) ENGINE=InnoDB;

CREATE TABLE WISHLIST (
  member_id BIGINT UNSIGNED NOT NULL,
  appid     INT UNSIGNED    NOT NULL,
  added_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (member_id, appid),
  KEY idx_wish_game (appid),
  CONSTRAINT fk_wish_member FOREIGN KEY (member_id) REFERENCES MEMBER(member_id) ON DELETE CASCADE,
  CONSTRAINT fk_wish_game   FOREIGN KEY (appid)     REFERENCES GAME(appid)       ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------------------
-- 4. 수집 로그 (appid FK 없음: 아직 등록 안 된 게임 호출도 기록)
-- ---------------------------------------------------------------------
CREATE TABLE API_SYNC_LOG (
  log_id      BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT,
  api         VARCHAR(40)       NOT NULL,             -- appdetails / GetAppReviews / GetMostPlayedGames
  appid       INT UNSIGNED      NULL,
  req_at      DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  status_code SMALLINT UNSIGNED NOT NULL,
  item_count  INT UNSIGNED      NOT NULL DEFAULT 0,
  error_msg   VARCHAR(500)      NULL,
  PRIMARY KEY (log_id),
  KEY idx_log_api_time (api, req_at),
  KEY idx_log_app_time (appid, req_at)
) ENGINE=InnoDB;

-- =====================================================================
-- 5. 뷰 : 3NF에서 뺀 값들을 계산해서 보여줌
-- =====================================================================
CREATE VIEW V_GAME_SUMMARY AS
SELECT g.appid, g.name, g.is_free,
       g.initial_price, g.final_price,
       CASE WHEN g.initial_price > 0
            THEN ROUND((g.initial_price - g.final_price) * 100 / g.initial_price)
       END AS discount_pct,                                            -- 할인율 (계산)
       g.ko_review_score, g.ko_positive, g.ko_negative,
       ROUND(g.ko_positive * 100 / NULLIF(g.ko_positive + g.ko_negative, 0), 1) AS ko_positive_pct,
       g.rank_no, g.last_week_rank, g.peak_in_game,
       (SELECT MAX(r.created_at) FROM REVIEW r WHERE r.appid = g.appid) AS last_review_at  -- 마지막 리뷰 시각 (계산)
FROM GAME g;

-- =====================================================================
-- 6. 샘플 데이터 : 스타듀밸리 실제 수집 값 (키워드 · mongo_id는 예시)
-- =====================================================================
INSERT INTO GAME (appid, name, is_free, required_age, release_date, coming_soon, metacritic,
                  header_image, recommendations_total, ko_review_score, ko_positive, ko_negative,
                  initial_price, final_price, currency, rank_date, rank_no, last_week_rank, peak_in_game)
VALUES (413150, 'Stardew Valley', FALSE, 0, '2016-02-27', FALSE, 89,
        'https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/413150/header.jpg',
        903843, 9, 35457, 690, 16000, 16000, 'KRW', '2026-11-06', 24, 26, 77865);

INSERT INTO GENRE VALUES (23, '인디'), (3, 'RPG'), (28, '시뮬레이션');
INSERT INTO GAME_GENRE VALUES (413150, 23), (413150, 3), (413150, 28);

INSERT INTO CATEGORY VALUES (2, '싱글 플레이어'), (1, '멀티플레이어'), (9, '협동');
INSERT INTO GAME_CATEGORY VALUES (413150, 2), (413150, 1), (413150, 9);

INSERT INTO COMPANY (name) VALUES ('ConcernedApe');
INSERT INTO GAME_COMPANY VALUES (413150, 1, 'developer'), (413150, 1, 'publisher');

INSERT INTO REVIEW (review_id, appid, steamid, language, voted_up, created_at, updated_at,
                    votes_up, votes_funny, steam_purchase, received_for_free, early_access,
                    playtime_at_review, playtime_forever, last_played, mongo_id) VALUES
 (239565057, 413150, 76561198119563961, 'koreana', TRUE,  '2026-11-07 11:01:28', '2026-11-07 11:01:28',
  0, 0, TRUE, FALSE, FALSE,  1505,  1505, '2026-01-05 00:08:34', '000000000000000000000001'),
 (239500180, 413150, 76561198304177471, 'koreana', TRUE,  '2026-11-06 21:10:30', '2026-11-06 21:10:30',
  0, 0, TRUE, FALSE, FALSE,  3052,  3365, '2026-11-07 13:12:37', '000000000000000000000002'),
 (239164124, 413150, 76561199756101234, 'koreana', FALSE, '2026-11-02 13:30:29', '2026-11-02 13:30:29',
  0, 0, TRUE, FALSE, FALSE, 38800, 39599, '2026-11-07 13:37:35', '000000000000000000000003');

INSERT INTO KEYWORD (word) VALUES ('게임'), ('모드'), ('요소'), ('중독'), ('셰인'), ('거짓말');
INSERT INTO REVIEW_KEYWORD VALUES
 (239565057, 1, 1),
 (239500180, 2, 2), (239500180, 3, 1), (239500180, 4, 1),
 (239164124, 5, 1), (239164124, 6, 1);

INSERT INTO MEMBER (email, password_hash, nickname) VALUES ('user@mail.com', '$2b$10$example', '농부');
INSERT INTO WISHLIST (member_id, appid) VALUES (1, 413150);

INSERT INTO API_SYNC_LOG (api, appid, status_code, item_count)
VALUES ('GetAppReviews', 413150, 200, 100), ('appdetails', 2357570, 200, 0);

-- =====================================================================
-- 7. 확인 쿼리
-- =====================================================================

-- ① 게임 상세: 할인율·추천 비율은 뷰에서 계산, 장르·개발사 묶어 보기
SELECT s.*,
       (SELECT GROUP_CONCAT(ge.name) FROM GAME_GENRE gg JOIN GENRE ge USING (genre_id)
         WHERE gg.appid = s.appid) AS genres,
       (SELECT GROUP_CONCAT(c.name) FROM GAME_COMPANY gc JOIN COMPANY c USING (company_id)
         WHERE gc.appid = s.appid AND gc.role = 'developer') AS developers
FROM V_GAME_SUMMARY s WHERE s.appid = 413150;

-- ② 카테고리 필터: "협동" 게임 목록
SELECT g.appid, g.name
FROM GAME g JOIN GAME_CATEGORY gc USING (appid) JOIN CATEGORY c USING (category_id)
WHERE c.name = '협동';

-- ③ GAME_KEYWORD 재계산 (수집 배치 끝에 실행)
DELETE FROM GAME_KEYWORD WHERE appid = 413150;
INSERT INTO GAME_KEYWORD (appid, keyword_id, voted_up, review_cnt)
SELECT r.appid, rk.keyword_id, r.voted_up, COUNT(*)
FROM REVIEW r JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
WHERE r.appid = 413150
GROUP BY r.appid, rk.keyword_id, r.voted_up;

-- ④ 추천 vs 비추천 키워드: 집단 안 비율 (분모는 REVIEW에서 바로 셈)
SELECT CASE WHEN gk.voted_up THEN '추천' ELSE '비추천' END AS side,
       k.word, gk.review_cnt, grp.total,
       ROUND(gk.review_cnt * 100 / grp.total, 1) AS pct
FROM GAME_KEYWORD gk
JOIN KEYWORD k USING (keyword_id)
JOIN (SELECT appid, voted_up, COUNT(*) AS total
        FROM REVIEW GROUP BY appid, voted_up) grp
  ON grp.appid = gk.appid AND grp.voted_up = gk.voted_up
WHERE gk.appid = 413150
ORDER BY gk.voted_up DESC, pct DESC;

-- ⑤ 플레이 시간대별 키워드 (10시간 = 600분, 100시간 = 6000분)
SELECT CASE WHEN r.playtime_at_review < 600  THEN '10시간 미만'
            WHEN r.playtime_at_review >= 6000 THEN '100시간 이상'
            ELSE '10~100시간' END AS play_band,
       k.word, COUNT(*) AS review_cnt
FROM REVIEW r
JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
JOIN KEYWORD k ON k.keyword_id = rk.keyword_id
WHERE r.appid = 413150
GROUP BY play_band, k.word
ORDER BY play_band, review_cnt DESC;

-- ⑥ 리뷰 목록: steamid는 표시만 (원문은 mongo_id로 MongoDB에서 조회)
SELECT review_id, steamid, voted_up, ROUND(playtime_at_review / 60) AS hours, created_at, mongo_id
FROM REVIEW WHERE appid = 413150 ORDER BY created_at DESC;
