-- 팀 원본 v2의 샘플 데이터 (스타듀밸리). 빈 DB에서 확인용으로만 실행하세요.
-- Workbench: steam DB를 선택(더블클릭)한 뒤 실행

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

