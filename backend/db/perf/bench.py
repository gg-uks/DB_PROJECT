import json, os, statistics, sys, time, pymysql

def conn(db):
    return pymysql.connect(user=os.getenv("DB_USER", "root"), password=os.getenv("DB_PASS", ""),
                           unix_socket=os.getenv("DB_SOCKET", "/run/mysqld/mysqld.sock"), database=db, charset="utf8mb4")

G = 1005
Q = {
 "kw_pre": f"SELECT k.word, SUM(gk.review_cnt) c FROM GAME_KEYWORD gk JOIN KEYWORD k USING (keyword_id) WHERE gk.appid={G} AND gk.voted_up=1 GROUP BY k.word ORDER BY c DESC, k.word LIMIT 10",
 "kw_live": f"SELECT k.word, COUNT(*) c FROM REVIEW r JOIN REVIEW_KEYWORD rk ON rk.review_id=r.review_id JOIN KEYWORD k ON k.keyword_id=rk.keyword_id WHERE r.appid={G} AND r.voted_up=1 GROUP BY k.word ORDER BY c DESC, k.word LIMIT 10",
 "cnt_idx": f"SELECT COUNT(*) FROM REVIEW WHERE appid={G} AND voted_up=1",
 "cnt_noidx": f"SELECT COUNT(*) FROM REVIEW IGNORE INDEX (idx_review_vote, uk_review_author_game, idx_review_play) WHERE appid={G} AND voted_up=1",
 "band_idx": f"SELECT COUNT(*) FROM REVIEW WHERE appid={G} AND playtime_at_review < 600",
 "band_noidx": f"SELECT COUNT(*) FROM REVIEW IGNORE INDEX (idx_review_vote, uk_review_author_game, idx_review_play) WHERE appid={G} AND playtime_at_review < 600",
 "rank_idx": f"SELECT keyword_id, review_cnt FROM GAME_KEYWORD WHERE appid={G} AND voted_up=1 ORDER BY review_cnt DESC LIMIT 10",
 "rank_noidx": f"SELECT keyword_id, review_cnt FROM GAME_KEYWORD IGNORE INDEX (idx_gk_rank) WHERE appid={G} AND voted_up=1 ORDER BY review_cnt DESC LIMIT 10",
 "stat_derived": """SELECT g.appid, COALESCE(r.pos,0) pos, COALESCE(k.kw,0) kw, COALESCE(w.wished,0) wished FROM GAME g
   LEFT JOIN (SELECT appid, SUM(voted_up=1) pos FROM REVIEW GROUP BY appid) r ON r.appid=g.appid
   LEFT JOIN (SELECT appid, COUNT(*) kw FROM GAME_KEYWORD GROUP BY appid) k ON k.appid=g.appid
   LEFT JOIN (SELECT appid, COUNT(*) wished FROM WISHLIST GROUP BY appid) w ON w.appid=g.appid ORDER BY g.appid""",
 "offset": "SELECT review_id, mongo_id FROM REVIEW ORDER BY review_id LIMIT 200 OFFSET 70000",
 "keyset": "SELECT review_id, mongo_id FROM REVIEW WHERE review_id > 70000 ORDER BY review_id LIMIT 200",
 "stat_naive": """SELECT g.appid, SUM(r.voted_up=1) pos, COUNT(k.keyword_id) kw, COUNT(w.member_id) wished FROM GAME g
   LEFT JOIN REVIEW r ON r.appid=g.appid LEFT JOIN GAME_KEYWORD k ON k.appid=g.appid LEFT JOIN WISHLIST w ON w.appid=g.appid
   GROUP BY g.appid ORDER BY g.appid""",
}

def run(db, names, n=30):
    c = conn(db); k = c.cursor(); out = {}
    for name in names:
        sql = Q[name]
        k.execute("EXPLAIN " + sql); cols = [d[0] for d in k.description]
        plan = [dict(zip(cols, r)) for r in k.fetchall()]
        k.execute(sql); res = k.fetchall()
        ts = []
        for _ in range(n):
            t = time.perf_counter(); k.execute(sql); k.fetchall(); ts.append((time.perf_counter() - t) * 1000)
        out[name] = {"ms": round(statistics.median(ts), 2), "plan": [{x: p.get(x) for x in ("table", "type", "key", "rows", "Extra")} for p in plan],
                     "first": [list(map(str, r)) for r in res[:2]]}
    return out

db = sys.argv[1]; names = sys.argv[2].split(",") if len(sys.argv) > 2 else list(Q)
n = int(sys.argv[3]) if len(sys.argv) > 3 else 30
print(json.dumps(run(db, names, n), ensure_ascii=False, indent=1, default=str))
