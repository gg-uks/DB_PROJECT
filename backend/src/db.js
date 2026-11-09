/**
 * 새로 추가한 코드가 함께 쓰는 DB 연결.
 *  - writePool: MYSQL_HOST (Source) · INSERT/UPDATE/DELETE
 *  - readPool : MYSQL_READ_HOST (Replica) · 없으면 MYSQL_HOST를 그대로 사용
 *  - mongoDb(): MongoDB (review_text 리뷰 원문 · game_raw 게임 상세 원본)
 */
import mysql from "mysql2/promise";
import { MongoClient } from "mongodb";

function poolFor(host, limit) {
  return mysql.createPool({
    host,
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE || "steam",
    charset: "utf8mb4",
    timezone: "+09:00", // 설계서: 시각은 한국 시간(KST)으로 저장
    connectionLimit: limit,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
}

const writeHost = process.env.MYSQL_HOST || "127.0.0.1";
const readHost = process.env.MYSQL_READ_HOST || writeHost;

export const writePool = poolFor(writeHost, 5);
export const readPool = readHost === writeHost ? writePool : poolFor(readHost, 5);

let mongoClient;
export async function mongoDb() {
  if (!mongoClient) {
    mongoClient = new MongoClient(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017", {
      serverSelectionTimeoutMS: 5000,
    });
    await mongoClient.connect();
  }
  return mongoClient.db(process.env.MONGODB_DATABASE || "playlog");
}

export async function closeDb() {
  await Promise.allSettled([
    writePool.end(),
    readPool !== writePool ? readPool.end() : null,
    mongoClient?.close(),
  ]);
}
