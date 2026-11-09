import kafkaJs from "kafkajs";
import mysql from "mysql2/promise";

const { Kafka } = kafkaJs;

const kafka = new Kafka({
  clientId: "playlog-mysql",
  brokers: (process.env.KAFKA_BROKERS || "localhost:9092")
    .split(",")
    .map((broker) => broker.trim())
    .filter(Boolean),
});

const consumer = kafka.consumer({
  groupId: "playlog-games-mysql-v1",
  allowAutoTopicCreation: false,
});

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE || "playlog_dev",
  charset: "utf8mb4",
  connectionLimit: 2,
});

let stopping = false;

async function stop() {
  if (stopping) return;
  stopping = true;

  try {
    await consumer.disconnect();
  } finally {
    await pool.end();
  }
}

function fail(error) {
  console.error("Consumer 실패:", error.message);
  process.exitCode = 1;
}

process.once("SIGINT", () => stop().catch(fail));
process.once("SIGTERM", () => stop().catch(fail));

consumer.on(consumer.events.CRASH, ({ payload }) => {
  console.error("Consumer 오류:", payload.error.message);

  if (!payload.restart) {
    process.exitCode = 1;
    stop().catch(fail);
  }
});

async function main() {
  await pool.query("SELECT appid FROM games LIMIT 1");
  await consumer.connect();
  await consumer.subscribe({
    topic: "steam.games",
    fromBeginning: true,
  });

  console.log("steam.games 수신 대기 중");

  await consumer.run({
    autoCommit: false,

    eachMessage: async ({ topic, partition, message }) => {
      const { appid, name } = JSON.parse(message.value?.toString() ?? "{}");

      if (
        !Number.isInteger(appid) ||
        appid < 1 ||
        appid > 4294967295 ||
        typeof name !== "string" ||
        !name.trim() ||
        Array.from(name).length > 512
      ) {
        throw new Error(`잘못된 게임 이벤트 (offset ${message.offset})`);
      }

      await pool.execute(
        `INSERT INTO games (appid, name, collected_at)
         VALUES (?, ?, UTC_TIMESTAMP(3))
         ON DUPLICATE KEY UPDATE name = VALUES(name)`,
        [appid, name],
      );

      // MySQL 저장 성공 후 다음 메시지의 위치를 기록합니다.
      await consumer.commitOffsets([
        {
          topic,
          partition,
          offset: (BigInt(message.offset) + 1n).toString(),
        },
      ]);

      console.log(`MySQL 저장 완료 · ${appid} · ${name}`);
    },
  });
}

main().catch(async (error) => {
  fail(error);
  await stop().catch(fail);
});
