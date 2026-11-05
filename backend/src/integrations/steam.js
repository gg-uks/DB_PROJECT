/**
 * [Steam 리뷰 수집용 외부 API]
 *
 * 실행 위치: 백엔드 수집기
 * 공식 문서:
 * https://partner.steamgames.com/doc/webapi/IUserReviewsService
 *
 * 수집 흐름:
 * Steam API
 * → 원본 보존
 * → 리뷰 정제
 * → MongoDB 저장
 * → 키워드 분석
 * → Elasticsearch 반영
 *
 * 현재는 주석 예제이며 실제 수집·저장은 실행하지 않습니다.
 */

// export async function fetchSteamReviews(
//   appid,
//   cursor = '*',
//   language = 'koreana'
// ) {
//   const url = new URL(
//     'https://api.steampowered.com/IUserReviewsService/GetAppReviews/v1/'
//   );
//
//   url.searchParams.set(
//     'input_json',
//     JSON.stringify({
//       appid,
//       languages: [language], // 영어 리뷰는 'english'
//       cursor,
//       filter: 1,            // 최신순
//       num_per_page: 100
//     })
//   );
//
//   const response = await fetch(url, {
//     signal: AbortSignal.timeout(15000)
//   });
//
//   if (response.status === 429) {
//     throw new Error('Steam 호출 제한: 잠시 후 재시도 필요');
//   }
//
//   if (!response.ok) {
//     throw new Error(`Steam API 오류: ${response.status}`);
//   }
//
//   const data = await response.json();
//
//   // TODO: 실제 응답 구조 검증
//   // TODO: 리뷰 ID 기준 중복 방지
//   // TODO: 반환된 cursor로 다음 페이지 요청
//   // TODO: 빈 리뷰 목록이면 수집 종료
//   // TODO: MongoDB 저장 및 실패 시 재처리
//
//   return data;
// }
