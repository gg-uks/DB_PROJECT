/** Steam API 호출 1건마다 API_SYNC_LOG에 기록 (요구사항 19) */
import { setApiLogger } from "../integrations/steam-api.js";

export function enableApiLog(pool) {
  setApiLogger(async ({ api, appid, status, count, error }) => {
    await pool.execute(
      `INSERT INTO API_SYNC_LOG (api, appid, status_code, item_count, error_msg)
       VALUES (?, ?, ?, ?, ?)`,
      [
        String(api).slice(0, 40),
        Number.isInteger(appid) ? appid : null,
        Number.isInteger(status) ? status : 0, // 연결 자체가 실패하면 0 + error_msg
        Number.isInteger(count) ? count : 0,
        error ? String(error).slice(0, 500) : null,
      ],
    );
  });
}
