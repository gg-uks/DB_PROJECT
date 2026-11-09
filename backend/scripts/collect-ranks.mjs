/**
 * 순위 갱신 (매일 확인 · 값은 주 단위) · 요구사항 6
 *   ① GetMostPlayedGames 상위 100 → GAME의 rank_date · rank_no · last_week_rank · peak_in_game를 최신값으로 덮어씀
 *   이번 주 100위 밖이면 순위 값은 비워 둠(NULL) · 지난주 순위 -1(신규 진입)도 NULL
 *
 * 실행: npm run collect:ranks -w backend
 */
import { writePool, closeDb } from "../src/db.js";
import { enableApiLog } from "../src/services/api-log.js";
import { getMostPlayedGames } from "../src/integrations/steam-api.js";

export async function saveRanks(pool, { rollupDate, ranks }) {
  const day = new Date(rollupDate.getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10); // KST 날짜
  const byApp = new Map(ranks.map((r) => [r.appid, r]));
  const [games] = await pool.query("SELECT appid FROM GAME");
  let ranked = 0;
  for (const { appid } of games) {
    const r = byApp.get(Number(appid));
    if (r) ranked++;
    await pool.execute(
      "UPDATE GAME SET rank_date = ?, rank_no = ?, last_week_rank = ?, peak_in_game = ? WHERE appid = ?",
      [day, r ? r.rank : null, r ? r.lastWeekRank : null, r ? r.peak : null, appid],
    );
  }
  return { day, ranked, games: games.length };
}

async function main() {
  enableApiLog(writePool);
  const result = await saveRanks(writePool, await getMostPlayedGames());
  console.log(`순위 갱신 · 기준일 ${result.day} · 상위 100 안 ${result.ranked}/${result.games}개`);
}

if (process.argv[1]?.endsWith("collect-ranks.mjs")) {
  main()
    .catch((error) => {
      console.error("순위 수집 실패:", error.message);
      process.exitCode = 1;
    })
    .finally(closeDb);
}
