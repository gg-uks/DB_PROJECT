# 쿼리 성능 측정 (발표 "쿼리 최적화" 슬라이드의 숫자)

운영 DB가 아니라 **테스트용 DB**에서 실행한다. 스키마는 `backend/db/schema.sql` 그대로, 데이터는 가짜.

```bash
pip install pymysql
mysql -u root -e "CREATE DATABASE perf CHARACTER SET utf8mb4; CREATE DATABASE perf10 CHARACTER SET utf8mb4;"
mysql -u root perf   < ../schema.sql
mysql -u root perf10 < ../schema.sql

python3 gen.py 1  perf      # VM과 같은 규모: 게임 30 · 리뷰 7,500 · 리뷰-키워드 약 5.5만
python3 gen.py 10 perf10    # 10배: 리뷰 75,000 · 리뷰-키워드 약 55만

python3 bench.py perf   cnt_idx,cnt_noidx,band_idx,band_noidx,rank_idx,rank_noidx,kw_pre,kw_live,stat_derived 30
python3 bench.py perf   stat_naive 3            # 느림 (약 14초)
python3 bench.py perf10 offset,keyset 20
```
- 결과: 쿼리마다 `ms`(30회 중앙값) · `plan`(EXPLAIN의 type · key · rows · Extra) · 첫 행
- `*_noidx`는 `IGNORE INDEX`로 인덱스가 없을 때를 재현
- 접속 정보는 환경변수 `DB_USER` · `DB_PASS` · `DB_SOCKET`

| 이름 | 비교 내용 |
|---|---|
| `cnt_idx` / `cnt_noidx` | 추천 리뷰 수 — `idx_review_vote` 있음 / 없음 |
| `band_idx` / `band_noidx` | 플레이 시간대 — `idx_review_play` 있음 / 없음 |
| `rank_idx` / `rank_noidx` | 게임별 상위 키워드 정렬 — `idx_gk_rank` 있음 / 없음(filesort) |
| `kw_pre` / `kw_live` | 미리 집계한 GAME_KEYWORD / 3중 JOIN 실시간 집계 |
| `stat_derived` / `stat_naive` | 먼저 집계 후 LEFT JOIN / JOIN 후 집계(행 곱해짐 · 값 틀림) |
| `keyset` / `offset` | `WHERE review_id > ?` / `OFFSET 70000` |
