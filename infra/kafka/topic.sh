#!/usr/bin/env bash
# Kafka 토픽 생성 · 확인 (.31)
set -e
BIN=/opt/kafka/bin
$BIN/kafka-topics.sh --bootstrap-server localhost:9092 --create --if-not-exists \
  --topic steam.reviews --partitions 2 --replication-factor 1
$BIN/kafka-topics.sh --bootstrap-server localhost:9092 --describe --topic steam.reviews
# consumer 처리 상태 (LAG 0 = 저장 완료)
$BIN/kafka-consumer-groups.sh --bootstrap-server localhost:9092 --describe --group playlog-reviews-db-v3 || true
