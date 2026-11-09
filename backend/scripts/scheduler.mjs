/**
 * 수집 · 가공 스케줄러 (WEB1 VM에서 한 대만 실행)
 *   03:00  게임 상세(GAME 최신값 · 장르 · 카테고리 · 회사) → 리뷰 수집 (추천 125 · 비추천 125, Kafka 발행)
 *   04:30  표본 정리(125건 초과 삭제) → 키워드 추출 → GAME_KEYWORD 재계산
 *   05:00  순위 갱신 (GAME.rank_* 최신값, 기준일은 주 단위)
 *   현재 동시 접속자 수는 수집하지 않음 (설계서 요구사항 7)
 *
 * 실행: npm run scheduler -w backend   (VM에서는 pm2 start npm --name scheduler -- run scheduler -w backend)
 * 리뷰 consumer(npm run reviews:consume)는 WEB1 · WEB2에서 따로 계속 켜 둡니다.
 */
import cron from "node-cron";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendDir = fileURLToPath(new URL("..", import.meta.url));
const running = new Set();

function runScript(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--env-file-if-exists=.env", ...args], {
      cwd: backendDir,
      stdio: "inherit",
    });
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${args.join(" ")} 종료 코드 ${code}`))));
    child.on("error", reject);
  });
}

function job(name, steps) {
  return async () => {
    if (running.has(name)) {
      console.warn(`[${name}] 이전 실행이 아직 끝나지 않아 건너뜀`);
      return;
    }
    running.add(name);
    const started = Date.now();
    console.log(`[${name}] 시작 ${new Date().toISOString()}`);
    try {
      for (const step of steps) await runScript(step);
      console.log(`[${name}] 완료 · ${Math.round((Date.now() - started) / 1000)}초`);
    } catch (error) {
      console.error(`[${name}] 실패 · ${error.message}`);
    } finally {
      running.delete(name);
    }
  };
}

const timezone = process.env.TZ_SCHEDULE || "Asia/Seoul";
const jobs = {
  collect: job("collect", [["scripts/collect-game-details.mjs"], ["scripts/steam-reviews.mjs", "produce"]]),
  keywords: job("keywords", [["scripts/trim-reviews.mjs"], ["scripts/extract-keywords.mjs"], ["scripts/aggregate-keywords.mjs"]]),
  ranks: job("ranks", [["scripts/collect-ranks.mjs"]]),
};

cron.schedule("0 3 * * *", jobs.collect, { timezone });
cron.schedule("30 4 * * *", jobs.keywords, { timezone });
cron.schedule("0 5 * * *", jobs.ranks, { timezone });
console.log(`스케줄러 시작 (${timezone}) · 03:00 수집 · 04:30 표본 정리 · 키워드 · 05:00 순위`);

// 바로 한 번 돌려 보고 싶을 때: node scripts/scheduler.mjs --now collect|keywords|ranks
const now = process.argv.indexOf("--now");
if (now !== -1 && jobs[process.argv[now + 1]]) jobs[process.argv[now + 1]]();
