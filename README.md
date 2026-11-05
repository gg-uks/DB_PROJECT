# PLAYLOG — 게임 리뷰 검색·추천 개발 시작점

Steam의 어두운 색상, 2단 메뉴, 대형 추천 배너를 참고한 독립 학습용 프로젝트입니다.
React + Vite 프론트엔드와 Node.js + Express 백엔드를 포함합니다. DB, Redis, Kafka, Elasticsearch는 아직 필요 없습니다.

## 1. 개발 환경

Node.js 24 LTS와 npm을 설치하세요. Windows에서는 VS Code 터미널(PowerShell 또는 CMD)에서 실행할 수 있습니다.
압축 해제 후 package.json이 있는 game-review 폴더를 엽니다.

```sh
cd game-review
npm ci
npm run dev
```

- 화면: http://localhost:5173
- API 상태: http://localhost:3001/api/health
- 종료: Ctrl+C
- 루트에서 한 번 설치하면 frontend/backend가 npm workspaces로 함께 설치됩니다.
- 기본 포트: 프론트 5173, 백엔드 3001. 다른 프로그램이 사용 중이면 종료하거나 설정을 함께 수정하세요.
- 개발 프록시: frontend/vite.config.js에서 /api를 3001로 전달합니다.
- backend/.env.example을 backend/.env로 복사하면 PORT를 설정할 수 있습니다. 변경하면 프론트 프록시 포트도 맞추세요.

## 2. 현재 화면과 동작

- 네이비 배경, 상단 메뉴, 자연어 형태 입력창
- 추천 배너와 수동 슬라이드 전환
- 게임 카드 8개, 태그 필터, 검색 결과 및 빈 결과
- 게임 카드 클릭 시 상세 모달과 키워드 크기 미리보기
- 재밌게 한 게임 선택 → 긍정 리뷰의 키워드 벡터 코사인 유사도로 다른 게임 추천
- 모바일 대응, API 오류 표시

모든 리뷰와 가격은 목데이터입니다. 게임 제목과 외부 Steam 이미지 URL은 시각적 시연에 사용합니다.
외부 이미지 로딩에는 인터넷 연결이 필요합니다. 이미지가 차단돼도 제목·태그·API는 동작합니다.
공식 Steam 로그인·결제·스토어 연동은 없습니다.

## 3. 검색·분석 범위

검색은 한국어 동의어 사전과 목리뷰 키워드 집계 방식이며 LLM/의미 검색이 아닙니다.
예: 친구와 함께, 혼자 즐기는 스토리, 힐링 농장 게임.
검색 문장의 부정 표현(예: 어렵지 않은 게임)은 아직 해석하지 않습니다.
리뷰 키워드는 시연을 위해 수동 라벨링했으며 본문에서 자동 추출하지 않습니다.
워드클라우드는 빈도에 따른 크기 표시의 초기 형태로 실제 단어 충돌 배치 엔진은 사용하지 않습니다.
각 게임에 샘플 리뷰 12건(긍정 9건/부정 3건)이 있습니다. 통계는 실제 Steam 평가가 아닙니다.

## 4. 폴더

```text
frontend/src/main.jsx             화면과 API 호출
frontend/src/style.css            스타일·반응형
frontend/vite.config.js           개발 프록시
backend/src/server.js             HTTP 라우트
backend/src/services/catalog.js   데이터 조회·키워드 집계·추천
backend/src/mocks/games.json      정형 목게임 8건
backend/src/mocks/reviews.json    목리뷰 96건
```

## 5. API

| Method | 경로 | 요청 |
|---|---|---|
| GET | /api/health | 없음 |
| GET | /api/games | 없음 |
| GET | /api/games/:id | 없음 |
| GET | /api/games/:id/reviews | 없음 |
| GET | /api/games/:id/keywords | 없음 |
| POST | /api/search | {"query":"친구와 함께"} |
| POST | /api/recommendations | {"gameIds":[413150]} |

게임 id는 Steam 앱 ID를 사용하며 리뷰의 gameId와 연결됩니다.
POST는 Content-Type: application/json으로 전송합니다.

## 6. 빌드 및 VM 실행

```sh
npm run build
npm start
```

빌드 후에는 Node.js가 React 정적 파일과 API를 같은 3001 포트에서 제공합니다.
http://localhost:3001 로 확인하세요. 개발 시에는 5173으로 접속합니다.
웹 VM 두 대에 동일한 소스를 배포하고 HAProxy가 각 VM의 3001 포트로 전달하게 할 수 있습니다.
HAProxy 헬스체크 경로: /api/health.
방화벽은 실제 내부망·HAProxy 주소에 맞게 제한하세요. DB와 서비스 비밀키는 frontend에 넣지 마세요.

## 7. 다음 개발 순서

1. 디자인·메인페이지 구조 확정.
2. 상세 모달을 별도 상세페이지로 확장하고 리뷰 목록·긍정/부정 필터 추가.
3. 실제 수집 원본을 MySQL(게임), MongoDB(리뷰)에 저장하고 catalog.js 조회부 교체.
4. 리뷰 정제·언어 처리·키워드 추출 작업 추가.
5. Elasticsearch 검색, Redis 조회 캐시, Kafka 수집 이벤트 연결.
6. DB 복제 및 VM 분산 배포·장애 테스트.

고정된 목데이터를 사용하는 현재 앱은 다중 WEB에서 공유 쓰기 상태가 없습니다.
실제 즐겨찾기·로그인 등은 공용 DB/세션 저장소를 도입하면서 추가하세요.
