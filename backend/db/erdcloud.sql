-- =====================================================================
--  PLAYLOG — ERDCloud 가져오기용 DDL (MySQL)
--  ERDCloud: 새 ERD → 상단 메뉴 [가져오기(Import)] → SQL → 아래 전체 붙여넣기
--    · 테이블 COMMENT = 논리 테이블명 · 컬럼 COMMENT = 논리 컬럼명
--    · 설계 14개 테이블 (로그인 세션 MEMBER_SESSION은 구현용이라 제외)
--    · 외래키는 맨 아래 ALTER TABLE로 따로 추가 → 관계선이 자동으로 그려짐
--    · 실제 DB(schema.sql)에만 있는 것: 보조 인덱스 · CHECK 2개 · 뷰 V_GAME_SUMMARY
-- =====================================================================

CREATE TABLE GAME (
  appid                 INT UNSIGNED      NOT NULL COMMENT '앱 번호',
  name                  VARCHAR(255)      NOT NULL COMMENT '게임 이름',
  is_free               BOOLEAN           NOT NULL DEFAULT FALSE COMMENT '무료 여부',
  required_age          TINYINT UNSIGNED  NOT NULL DEFAULT 0 COMMENT '이용 연령',
  release_date          DATE              NULL COMMENT '출시일',
  coming_soon           BOOLEAN           NOT NULL DEFAULT FALSE COMMENT '출시 예정 여부',
  metacritic            TINYINT UNSIGNED  NULL COMMENT '메타크리틱 점수',
  header_image          VARCHAR(500)      NULL COMMENT '대표 이미지 URL',
  recommendations_total INT UNSIGNED      NULL COMMENT '전체 언어 추천 수',
  ko_review_score       TINYINT UNSIGNED  NULL COMMENT '한국어 평가 등급(1~9)',
  ko_positive           INT UNSIGNED      NOT NULL DEFAULT 0 COMMENT '한국어 추천 수',
  ko_negative           INT UNSIGNED      NOT NULL DEFAULT 0 COMMENT '한국어 비추천 수',
  initial_price         INT UNSIGNED      NULL COMMENT '정가(원)',
  final_price           INT UNSIGNED      NULL COMMENT '판매가(원)',
  currency              CHAR(3)           NULL COMMENT '통화',
  rank_date             DATE              NULL COMMENT '순위 기준일',
  rank_no               SMALLINT UNSIGNED NULL COMMENT '순위',
  last_week_rank        SMALLINT UNSIGNED NULL COMMENT '지난주 순위',
  peak_in_game          INT UNSIGNED      NULL COMMENT '주간 최고 동시 접속자',
  updated_at            DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '마지막 수집 시각',
  PRIMARY KEY (appid)
) COMMENT = '게임';

CREATE TABLE GENRE (
  genre_id INT         NOT NULL COMMENT '장르 번호(스팀)',
  name     VARCHAR(50) NOT NULL COMMENT '장르명',
  PRIMARY KEY (genre_id)
) COMMENT = '장르';

CREATE TABLE GAME_GENRE (
  appid    INT UNSIGNED NOT NULL COMMENT '앱 번호',
  genre_id INT          NOT NULL COMMENT '장르 번호',
  PRIMARY KEY (appid, genre_id)
) COMMENT = '게임-장르';

CREATE TABLE CATEGORY (
  category_id INT          NOT NULL COMMENT '카테고리 번호(스팀)',
  name        VARCHAR(100) NOT NULL COMMENT '카테고리명',
  PRIMARY KEY (category_id)
) COMMENT = '카테고리';

CREATE TABLE GAME_CATEGORY (
  appid       INT UNSIGNED NOT NULL COMMENT '앱 번호',
  category_id INT          NOT NULL COMMENT '카테고리 번호',
  PRIMARY KEY (appid, category_id)
) COMMENT = '게임-카테고리';

CREATE TABLE COMPANY (
  company_id INT          NOT NULL AUTO_INCREMENT COMMENT '회사 번호',
  name       VARCHAR(150) NOT NULL UNIQUE COMMENT '회사명',
  PRIMARY KEY (company_id)
) COMMENT = '회사';

CREATE TABLE GAME_COMPANY (
  appid      INT UNSIGNED                  NOT NULL COMMENT '앱 번호',
  company_id INT                           NOT NULL COMMENT '회사 번호',
  role       ENUM('developer','publisher') NOT NULL COMMENT '역할(개발/배급)',
  PRIMARY KEY (appid, company_id, role)
) COMMENT = '게임-회사';

CREATE TABLE REVIEW (
  review_id          BIGINT UNSIGNED NOT NULL COMMENT '리뷰 번호',
  appid              INT UNSIGNED    NOT NULL COMMENT '앱 번호',
  steamid            BIGINT UNSIGNED NOT NULL COMMENT '작성자 스팀ID',
  language           VARCHAR(20)     NOT NULL COMMENT '언어',
  voted_up           BOOLEAN         NOT NULL COMMENT '추천 여부',
  created_at         DATETIME        NOT NULL COMMENT '작성 시각',
  updated_at         DATETIME        NOT NULL COMMENT '수정 시각',
  votes_up           INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '도움됨 수',
  votes_funny        INT UNSIGNED    NOT NULL DEFAULT 0 COMMENT '웃김 수',
  steam_purchase     BOOLEAN         NOT NULL DEFAULT TRUE COMMENT '스팀 구매 여부',
  received_for_free  BOOLEAN         NOT NULL DEFAULT FALSE COMMENT '무료 획득 여부',
  early_access       BOOLEAN         NOT NULL DEFAULT FALSE COMMENT '앞서 해보기 중 작성',
  playtime_at_review INT UNSIGNED    NULL COMMENT '작성 시 플레이 시간(분)',
  playtime_forever   INT UNSIGNED    NULL COMMENT '누적 플레이 시간(분)',
  last_played        DATETIME        NULL COMMENT '마지막 플레이 시각',
  mongo_id           CHAR(24)        NOT NULL UNIQUE COMMENT '원문 번호(MongoDB _id)',
  PRIMARY KEY (review_id),
  UNIQUE (appid, steamid)
) COMMENT = '리뷰';

CREATE TABLE KEYWORD (
  keyword_id INT         NOT NULL AUTO_INCREMENT COMMENT '키워드 번호',
  word       VARCHAR(50) NOT NULL UNIQUE COMMENT '단어',
  PRIMARY KEY (keyword_id)
) COMMENT = '키워드';

CREATE TABLE REVIEW_KEYWORD (
  review_id  BIGINT UNSIGNED   NOT NULL COMMENT '리뷰 번호',
  keyword_id INT               NOT NULL COMMENT '키워드 번호',
  tf         SMALLINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '등장 횟수',
  PRIMARY KEY (review_id, keyword_id)
) COMMENT = '리뷰-키워드';

CREATE TABLE GAME_KEYWORD (
  appid      INT UNSIGNED NOT NULL COMMENT '앱 번호',
  keyword_id INT          NOT NULL COMMENT '키워드 번호',
  voted_up   BOOLEAN      NOT NULL COMMENT '추천 여부',
  review_cnt INT UNSIGNED NOT NULL COMMENT '나온 리뷰 수',
  PRIMARY KEY (appid, keyword_id, voted_up)
) COMMENT = '게임 키워드 집계(반정규화)';

CREATE TABLE MEMBER (
  member_id     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '회원 번호',
  email         VARCHAR(100)    NOT NULL UNIQUE COMMENT '이메일',
  password_hash VARCHAR(255)    NOT NULL COMMENT '비밀번호 해시',
  nickname      VARCHAR(30)     NOT NULL COMMENT '닉네임',
  created_at    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '가입일',
  PRIMARY KEY (member_id)
) COMMENT = '회원';

CREATE TABLE WISHLIST (
  member_id BIGINT UNSIGNED NOT NULL COMMENT '회원 번호',
  appid     INT UNSIGNED    NOT NULL COMMENT '앱 번호',
  added_at  DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '찜한 시각',
  PRIMARY KEY (member_id, appid)
) COMMENT = '찜';

CREATE TABLE API_SYNC_LOG (
  log_id      BIGINT UNSIGNED   NOT NULL AUTO_INCREMENT COMMENT '로그 번호',
  api         VARCHAR(40)       NOT NULL COMMENT 'API 이름',
  appid       INT UNSIGNED      NULL COMMENT '대상 앱 번호(FK 없음)',
  req_at      DATETIME          NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '요청 시각',
  status_code SMALLINT UNSIGNED NOT NULL COMMENT '응답 코드',
  item_count  INT UNSIGNED      NOT NULL DEFAULT 0 COMMENT '받은 건수',
  error_msg   VARCHAR(500)      NULL COMMENT '오류 내용',
  PRIMARY KEY (log_id)
) COMMENT = 'API 호출 기록';

-- ---------------------------------------------------------------------
-- 외래키 (관계선) — API_SYNC_LOG는 일부러 FK 없음 (미등록 게임 호출도 기록)
-- ---------------------------------------------------------------------
ALTER TABLE GAME_GENRE     ADD CONSTRAINT FK_GAME_TO_GAME_GENRE        FOREIGN KEY (appid)       REFERENCES GAME (appid);
ALTER TABLE GAME_GENRE     ADD CONSTRAINT FK_GENRE_TO_GAME_GENRE       FOREIGN KEY (genre_id)    REFERENCES GENRE (genre_id);
ALTER TABLE GAME_CATEGORY  ADD CONSTRAINT FK_GAME_TO_GAME_CATEGORY     FOREIGN KEY (appid)       REFERENCES GAME (appid);
ALTER TABLE GAME_CATEGORY  ADD CONSTRAINT FK_CATEGORY_TO_GAME_CATEGORY FOREIGN KEY (category_id) REFERENCES CATEGORY (category_id);
ALTER TABLE GAME_COMPANY   ADD CONSTRAINT FK_GAME_TO_GAME_COMPANY      FOREIGN KEY (appid)       REFERENCES GAME (appid);
ALTER TABLE GAME_COMPANY   ADD CONSTRAINT FK_COMPANY_TO_GAME_COMPANY   FOREIGN KEY (company_id)  REFERENCES COMPANY (company_id);
ALTER TABLE REVIEW         ADD CONSTRAINT FK_GAME_TO_REVIEW            FOREIGN KEY (appid)       REFERENCES GAME (appid);
ALTER TABLE REVIEW_KEYWORD ADD CONSTRAINT FK_REVIEW_TO_REVIEW_KEYWORD  FOREIGN KEY (review_id)   REFERENCES REVIEW (review_id);
ALTER TABLE REVIEW_KEYWORD ADD CONSTRAINT FK_KEYWORD_TO_REVIEW_KEYWORD FOREIGN KEY (keyword_id)  REFERENCES KEYWORD (keyword_id);
ALTER TABLE GAME_KEYWORD   ADD CONSTRAINT FK_GAME_TO_GAME_KEYWORD      FOREIGN KEY (appid)       REFERENCES GAME (appid);
ALTER TABLE GAME_KEYWORD   ADD CONSTRAINT FK_KEYWORD_TO_GAME_KEYWORD   FOREIGN KEY (keyword_id)  REFERENCES KEYWORD (keyword_id);
ALTER TABLE WISHLIST       ADD CONSTRAINT FK_MEMBER_TO_WISHLIST        FOREIGN KEY (member_id)   REFERENCES MEMBER (member_id);
ALTER TABLE WISHLIST       ADD CONSTRAINT FK_GAME_TO_WISHLIST          FOREIGN KEY (appid)       REFERENCES GAME (appid);
