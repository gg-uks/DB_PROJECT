# PLAYLOG DB · 수집 파이프라인 (팀 최종 스키마 `steam_review_schema_v2.sql` 기준)

- DB 이름: **`steam`** (`backend/.env` → `MYSQL_DATABASE=steam`)
- 수집 범위: **게임 30개 · 게임당 한국어 리뷰 추천 최신 125 + 비추천 최신 125 = 250건 · 총 7,500건**
  (3어절 미만 리뷰는 수집하지 않음)
- 가격 · 순위는 GAME에 **최신값만** 저장 (이력 없음) · 동시접속자 수는 수집하지 않음
- 시간은 KST, 비밀번호는 bcrypt 해시, 문자셋 utf8mb4

## 파일

| 파일 | 내용 |
|---|---|
| `steam_review_schema_v2.sql` | 팀이 준 원본 그대로 (참고용) |
| `schema.sql` | v2 1~5절 (테이블 14개 + 뷰) + 구현용 `MEMBER_SESSION` · `IF NOT EXISTS`라 여러 번 실행해도 안전 |
| `sample-data.sql` | v2 6절 예시 데이터 (Stardew Valley) |

### 테이블 (14개 + 구현용 1개)

| 테이블 | 채우는 스크립트 |
|---|---|
| GAME · GENRE · GAME_GENRE · CATEGORY · GAME_CATEGORY · COMPANY · GAME_COMPANY | `collect:details` (appdetails + 한국어 리뷰 요약) |
| GAME.rank_* · peak_in_game | `collect:ranks` (주간 최다 플레이 순위) |
| REVIEW (+ MongoDB `review_text`, `REVIEW.mongo_id` = `_id`) | `reviews:produce` → Kafka → `reviews:consume` |
| KEYWORD · REVIEW_KEYWORD | `keywords:extract` |
| GAME_KEYWORD (의도적 반정규화) | `keywords:aggregate` |
| MEMBER · WISHLIST | 웹 회원가입 · 찜 API |
| API_SYNC_LOG | 모든 Steam API 호출이 자동 기록 |
| **MEMBER_SESSION** (v2에 없음, 구현용) | 로그인 쿠키 토큰(SHA-256) · 24시간 만료 |

뷰 `V_GAME_SUMMARY`: 할인율 · 한국어 긍정률 · 마지막 리뷰 시각을 계산해서 보여줌 (메인 목록 API가 사용).

## 1. 처음 한 번

```sh
cd game-review
npm install
# backend/.env 작성 (backend/.env.example 참고, MYSQL_DATABASE=steam)
npm run db:init -w backend             # DB steam 생성 + 테이블 15개 + 뷰 1개
npm run db:init -w backend -- --sample # 예시 데이터까지 넣어보고 싶을 때
```

> 예전 DB(`playlog_dev` 등)는 Workbench에서 `DROP DATABASE playlog_dev;` 로 지우세요.
> `steam`을 처음부터 다시 만들 때: `DROP DATABASE steam;` → `npm run db:init -w backend`
> 비밀번호에 `#`이 있으면 `.env`에서 따옴표로 감싸야 합니다: `MYSQL_PASSWORD="pass123#"`

## 2. 수집 순서

```sh
npm run games:select -w backend      # (선택) 후보 게임 고르기 → data/target-games.json (30개)
npm run collect:details -w backend   # GAME · 장르 · 카테고리 · 개발/배급사
npm run collect:ranks -w backend     # 순위
npm run reviews:consume -w backend   # 터미널 하나에 띄워두기 (Kafka 수신 → Mongo → MySQL)
npm run reviews:produce -w backend   # 다른 터미널에서 리뷰 발행
#  └ Kafka가 없으면 위 두 줄 대신: npm run reviews:direct -w backend   (Steam → Mongo → MySQL 바로 저장)
npm run reviews:trim -w backend      # 표본당 최신 125건만 남기기
npm run keywords:extract -w backend  # KEYWORD · REVIEW_KEYWORD
npm run keywords:aggregate -w backend# GAME_KEYWORD
```

매일 자동: `npm run scheduler -w backend` (03:00 수집 → 04:30 정리·키워드 → 05:00 순위)

## 2-1. Elasticsearch · 워드클라우드 (선택)

```sh
# ES VM에서 한 번: nori 플러그인 설치 후 ES 재시작
bin/elasticsearch-plugin install analysis-nori

# backend/.env
ELASTICSEARCH_URL=http://192.168.56.33:9200
ELASTICSEARCH_INDEX=playlog-reviews-v2

npm run reviews:index -w backend -- --recreate   # 저장된 리뷰 전체를 nori 매핑 인덱스로 다시 색인
```

- 이후 새 리뷰는 `reviews:consume`이 저장하면서 자동으로 색인합니다.
- 게임 상세 화면의 **리뷰 워드클라우드**: `GET /api/analytics/games/:id/wordcloud?side=pos|neg`
  - ES가 있으면 nori로 명사만 뽑아 `terms` 집계(많이 나온 단어) + `significant_text`(이 게임만의 단어)
  - ES가 없거나 nori가 없으면 MySQL `GAME_KEYWORD`로 대신 보여줌 (화면 아래에 어느 쪽인지 표시)

## 2-2. 관리자 계정

`backend/.env`에 관리자 이메일을 넣고(쉼표로 여러 명), 그 이메일로 회원가입하면 헤더에 **관리자** 버튼이 생깁니다.

```
ADMIN_EMAILS=admin@playlog.com
```

- 관리자 페이지: `http://localhost:5173/#/admin` (개요 · 수집 현황 · 게임 데이터 · 회원 · 키워드)
- API `/api/admin/*`는 로그인하지 않으면 401, 관리자가 아니면 403
- MEMBER 테이블(팀 설계 v2)은 바꾸지 않고 .env로만 관리자를 정함
- 마이페이지: `#/mypage` (찜 목록 · 닉네임/비밀번호 변경 · 회원 탈퇴)

## 3. 확인 쿼리

```sql
USE steam;
SELECT * FROM V_GAME_SUMMARY;
SELECT appid, voted_up, COUNT(*) FROM REVIEW GROUP BY appid, voted_up;   -- 각 125
SELECT * FROM API_SYNC_LOG ORDER BY log_id DESC LIMIT 20;
```

## 4. 주의

- 테이블 이름은 **대문자**입니다. Linux(VM)의 MySQL은 대소문자를 구분하므로 코드도 대문자로 씁니다.
  Windows MySQL은 기본값(`lower_case_table_names=1`)이라 Workbench에서 소문자로 보이지만 동작은 같습니다.
- 키워드 비율의 분모(리뷰 수)는 저장하지 않고 REVIEW에서 바로 셉니다.
- 플레이타임 구간별 키워드(`band=lt10|mid|ge100`)와 유사 게임은 저장 테이블 없이 조회할 때 계산합니다.
