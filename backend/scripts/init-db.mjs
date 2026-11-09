/**
 * MySQL 테이블 생성 (v2: 14개 + 뷰 V_GAME_SUMMARY + 구현용 MEMBER_SESSION)
 * 실행: npm run db:init -w backend
 *   - .env의 MYSQL_DATABASE(기본 steam)가 없으면 만들고, db/schema.sql을 실행
 *   - 여러 번 실행해도 안전 (이미 있는 테이블 · 데이터는 그대로)
 *   - --sample 을 붙이면 db/sample-data.sql(스타듀밸리 예시)도 넣음: npm run db:init -w backend -- --sample
 */
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const database = process.env.MYSQL_DATABASE || "steam";
if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error("MYSQL_DATABASE 이름이 올바르지 않습니다.");

const connection = await mysql.createConnection({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  charset: "utf8mb4",
});

function statements(sql) {
  return sql
    .split(/;\s*\n/)
    .map((part) => part.replace(/^\s*--.*$/gm, "").trim())
    .filter(Boolean);
}

async function run(file) {
  const sql = await readFile(new URL(`../db/${file}`, import.meta.url), "utf8");
  let failed = 0;
  for (const statement of statements(sql)) {
    try {
      await connection.query(statement);
    } catch (error) {
      failed++;
      const name = statement.match(/(?:TABLE IF NOT EXISTS|VIEW|INTO)\s+(\w+)/)?.[1] ?? statement.slice(0, 40);
      console.error(`실패 · ${name} · ${error.message}`);
    }
  }
  console.log(`${file} 적용 완료 (실패 ${failed}건)`);
  return failed;
}

try {
  try {
    await connection.query(
      `CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`,
    );
  } catch {
    // MariaDB 등 utf8mb4_0900_ai_ci가 없는 서버
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${database}\` DEFAULT CHARACTER SET utf8mb4`);
  }
  await connection.query(`USE \`${database}\``);

  let failed = await run("schema.sql");
  if (process.argv.includes("--sample")) failed += await run("sample-data.sql");
  if (failed) process.exitCode = 1;

  const [tables] = await connection.query(
    `SELECT TABLE_NAME AS name, TABLE_TYPE AS type FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? ORDER BY TABLE_TYPE, TABLE_NAME`,
    [database],
  );
  const base = tables.filter((t) => t.type === "BASE TABLE").map((t) => t.name);
  const views = tables.filter((t) => t.type === "VIEW").map((t) => t.name);
  console.log(`DB ${database} · 테이블 ${base.length}개: ${base.join(", ")}`);
  console.log(`뷰 ${views.length}개: ${views.join(", ")}`);
} catch (error) {
  console.error("DB 초기화 실패:", error.message);
  process.exitCode = 1;
} finally {
  await connection.end();
}
