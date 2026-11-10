// pm2 실행 설정 — /opt/playlog 에서
//   WEB1:  pm2 start infra/pm2/ecosystem.config.cjs            (api · consumer · scheduler)
//   WEB2:  pm2 start infra/pm2/ecosystem.config.cjs --only api,consumer
//   이후:  pm2 save && pm2 startup systemd
// NODE_ENV=production 은 넣지 않음 (http 환경에서 로그인 쿠키가 secure가 되어 로그인 불가)
const cwd = "/opt/playlog";
const npm = (name, script) => ({
  name,
  cwd,
  script: "npm",
  args: `run ${script} -w backend`,
  autorestart: true,
  max_restarts: 20,
  restart_delay: 3000,
});

module.exports = {
  apps: [
    npm("api", "start"),                 // 화면 API :3001 (WEB1 · WEB2)
    npm("consumer", "reviews:consume"),  // Kafka steam.reviews 파티션 1개씩 담당 (WEB1 · WEB2)
    npm("scheduler", "scheduler"),       // 매일 03:00 · 04:30 · 05:00 수집 · 가공 (WEB1만)
  ],
};
