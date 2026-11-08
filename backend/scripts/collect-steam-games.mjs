import kafkaJs from "kafkajs";
import { setTimeout as delay } from "node:timers/promises";

const { Kafka } = kafkaJs;
const TARGET = 1000;
const PAGE_SIZE = 500;
const TOPIC = "steam.games";

async function collectGames(apiKey) {
  const games = [];
  let lastAppId = 0;

  while (games.length < TARGET) {
    const url = new URL(
      "https://api.steampowered.com/IStoreService/GetAppList/v1/",
    );

    url.searchParams.set(
      "input_json",
      JSON.stringify({
        include_games: true,
        include_dlc: false,
        include_software: false,
        include_videos: false,
        include_hardware: false,
        max_results: Math.min(PAGE_SIZE, TARGET - games.length),
        last_appid: lastAppId,
      }),
    );

    const response = await fetch(url, {
      headers: { "x-webapi-key": apiKey },
      signal: AbortSignal.timeout(30000),
    });

    if (!response.ok) {
      throw new Error(`Steam API 요청 실패 (HTTP ${response.status})`);
    }

    const { response: page } = await response.json();

    if (!Array.isArray(page?.apps)) {
      throw new Error("Steam 응답에서 response.apps를 찾지 못했습니다.");
    }

    if (page.apps.length === 0) break;

    for (const { appid, name } of page.apps) {
      if (
        !Number.isInteger(appid) ||
        appid <= lastAppId ||
        appid > 4294967295
      ) {
        throw new Error(`Steam 목록의 appid 순서 또는 값 오류: ${appid}`);
      }

      // 이름이 비어 있는 항목도 지나갈 수 있도록 먼저 위치를 갱신합니다.
      lastAppId = appid;

      if (
        typeof name === "string" &&
        name.trim() &&
        Array.from(name).length <= 512
      ) {
        games.push({ appid, name });
      }

      if (games.length === TARGET) break;
    }

    console.log(`Steam 수집 ${games.length}/${TARGET}건`);

    if (games.length === TARGET || page.have_more_results === false) break;

    await delay(1000);
  }

  if (games.length < TARGET) {
    throw new Error(
      `유효한 게임 ${games.length}건을 받았습니다. 목표는 ${TARGET}건입니다.`,
    );
  }

  return games;
}

async function main() {
  const apiKey = process.env.STEAM_WEB_API_KEY?.trim();

  if (!apiKey) {
    throw new Error("backend/.env에 STEAM_WEB_API_KEY를 설정해주세요.");
  }

  const games = await collectGames(apiKey);

  const kafka = new Kafka({
    clientId: "playlog-steam",
    brokers: (process.env.KAFKA_BROKERS || "localhost:9092")
      .split(",")
      .map((broker) => broker.trim())
      .filter(Boolean),
  });

  const producer = kafka.producer({ allowAutoTopicCreation: false });

  try {
    await producer.connect();

    await producer.send({
      topic: TOPIC,
      acks: -1,
      messages: games.map(({ appid, name }) => ({
        key: String(appid),
        value: JSON.stringify({ appid, name }),
      })),
    });

    console.log(`${TOPIC}에 게임 ${games.length}건 발행 완료`);
  } finally {
    await producer.disconnect();
  }
}

main().catch((error) => {
  console.error("Producer 실패:", error.message);
  process.exitCode = 1;
});