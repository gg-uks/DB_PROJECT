"""VM과 같은 규모(×scale)의 가짜 데이터를 perf DB에 채움.
게임 30 · 리뷰 게임×추천/비추천×125 · 리뷰당 키워드 약 7개(지프 분포) · GAME_KEYWORD는 B-4 쿼리로 집계."""
import random, sys, datetime, pymysql

scale = int(sys.argv[1]) if len(sys.argv) > 1 else 1
db = sys.argv[2] if len(sys.argv) > 2 else "perf"
random.seed(42)
import os
c = pymysql.connect(user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASS", ""), unix_socket=os.getenv("DB_SOCKET", "/run/mysqld/mysqld.sock"),
                    database=db, charset="utf8mb4", autocommit=False)
k = c.cursor()
k.execute("SET FOREIGN_KEY_CHECKS=0")
for t in ["GAME_KEYWORD", "REVIEW_KEYWORD", "KEYWORD", "REVIEW", "GAME_GENRE", "GENRE", "WISHLIST", "MEMBER", "GAME"]:
    k.execute(f"TRUNCATE {t}")
k.execute("SET FOREIGN_KEY_CHECKS=1")

games = list(range(1000, 1030))
for g in games:
    k.execute("INSERT INTO GAME (appid, name, ko_positive, ko_negative) VALUES (%s,%s,%s,%s)",
              (g, f"game{g}", random.randint(1000, 50000), random.randint(100, 9000)))
for gid in range(1, 11):
    k.execute("INSERT INTO GENRE VALUES (%s,%s)", (gid, f"genre{gid}"))
for g in games:
    for gid in random.sample(range(1, 11), random.randint(2, 4)):
        k.execute("INSERT INTO GAME_GENRE VALUES (%s,%s)", (g, gid))

V = 20000 * min(scale, 3)
k.executemany("INSERT INTO KEYWORD (keyword_id, word) VALUES (%s,%s)", [(i, f"w{i}") for i in range(1, V + 1)])
weights = [1 / (i ** 1.1) for i in range(1, V + 1)]

per = 125 * scale
rid = 1
reviews, rks = [], []
base = datetime.datetime(2025, 1, 1)
for g in games:
    for up in (1, 0):
        for n in range(per):
            reviews.append((rid, g, 76561190000000000 + rid, "koreana", up, base + datetime.timedelta(minutes=rid),
                            base + datetime.timedelta(minutes=rid), random.randint(0, 300), 0,
                            random.randint(1, 60000),   # playtime_at_review (분)
                            f"{rid:024x}"))
            for kw in set(random.choices(range(1, V + 1), weights=weights, k=8)):
                rks.append((rid, kw, random.randint(1, 3)))
            rid += 1
k.executemany("""INSERT INTO REVIEW (review_id, appid, steamid, language, voted_up, created_at, updated_at, votes_up,
                 votes_funny, playtime_at_review, mongo_id) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)""", reviews)
for i in range(0, len(rks), 20000):
    k.executemany("INSERT INTO REVIEW_KEYWORD VALUES (%s,%s,%s)", rks[i:i + 20000])
k.execute("""INSERT INTO GAME_KEYWORD (appid, keyword_id, voted_up, review_cnt)
             SELECT r.appid, rk.keyword_id, r.voted_up, COUNT(*) FROM REVIEW r JOIN REVIEW_KEYWORD rk ON rk.review_id = r.review_id
             GROUP BY r.appid, rk.keyword_id, r.voted_up""")
for m in range(1, 51):
    k.execute("INSERT INTO MEMBER (member_id, email, password_hash, nickname) VALUES (%s,%s,'x','n')", (m, f"m{m}@x"))
    for g in random.sample(games, 5):
        k.execute("INSERT INTO WISHLIST (member_id, appid) VALUES (%s,%s)", (m, g))
c.commit()
k.execute("ANALYZE TABLE REVIEW, REVIEW_KEYWORD, GAME_KEYWORD, KEYWORD")
k.fetchall()
for t in ["REVIEW", "KEYWORD", "REVIEW_KEYWORD", "GAME_KEYWORD"]:
    k.execute(f"SELECT COUNT(*) FROM {t}"); print(t, k.fetchone()[0])
