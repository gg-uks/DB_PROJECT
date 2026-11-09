/**
 * 게임 선정 (처음 한 번) · 설계서 기준
 *   ① 주간 최다 플레이 상위 100 → ② appdetails type = game 만 → ③ 한국어 비추천 100건 이상
 *   → 후보 목록을 data/game-candidates.json 에 저장하고 표로 출력
 *   이 중 6개 분류 × 5개 = 30개를 골라 data/target-games.json 에 넣습니다.
 *   --write 를 붙이면 순위 위 30개를 target-games.json 에 바로 씁니다 (분류는 직접 확인).
 *
 * 실행: npm run games:select -w backend           (후보만 보기)
 *       npm run games:select -w backend -- --write
 */
import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { writePool, closeDb } from "../src/db.js";
import { enableApiLog } from "../src/services/api-log.js";
import { getMostPlayedGames, getAppDetails, getKoreanSummary } from "../src/integrations/steam-api.js";

const MIN_KO_NEGATIVE = 100;

async function main() {
  enableApiLog(writePool);
  const { rollupDate, ranks } = await getMostPlayedGames();
  console.log(`순위 기준일 ${rollupDate.toISOString().slice(0, 10)} · 상위 ${ranks.length}개 확인 중 (약 ${Math.ceil(ranks.length * 3.2 / 60)}분)`);
  const candidates = [];
  for (const r of ranks) {
    await delay(1600);
    const data = await getAppDetails(r.appid).catch(() => null);
    if (!data || data.type !== "game") {
      console.log(`  제외 · ${r.rank}위 ${r.appid} (${data ? data.type : "상세 없음"})`);
      continue;
    }
    const summary = await getKoreanSummary(r.appid).catch(() => null);
    const neg = summary?.total_negative ?? 0;
    if (neg < MIN_KO_NEGATIVE) {
      console.log(`  제외 · ${r.rank}위 ${data.name} (한국어 비추천 ${neg}건)`);
      continue;
    }
    candidates.push({
      rank: r.rank,
      appid: r.appid,
      name: data.name,
      genres: (data.genres ?? []).map((g) => g.description),
      koPositive: summary.total_positive,
      koNegative: neg,
    });
    console.log(`  후보 · ${r.rank}위 ${data.name} · ${candidates.at(-1).genres.join(", ")} · 한국어 비추천 ${neg}`);
  }

  await writeFile(new URL("../data/game-candidates.json", import.meta.url),
    JSON.stringify({ rollupDate: rollupDate.toISOString().slice(0, 10), candidates }, null, 2) + "\n");
  console.log(`\n후보 ${candidates.length}개 → data/game-candidates.json`);

  if (process.argv.includes("--write")) {
    const games = candidates.slice(0, 30).map(({ appid, name, genres }) => ({ appid, name, category: genres[0] ?? "" }));
    await writeFile(new URL("../data/target-games.json", import.meta.url), JSON.stringify({
      _설명: "수집 대상 30개 (6개 분류 × 5개). category는 직접 정한 분류로 바꿔도 됩니다.",
      games,
    }, null, 2) + "\n");
    console.log(`target-games.json 에 ${games.length}개 저장 · 분류(category)는 직접 확인해서 조정하세요.`);
  }
}

main()
  .catch((error) => {
    console.error("게임 선정 실패:", error.message);
    process.exitCode = 1;
  })
  .finally(closeDb);
