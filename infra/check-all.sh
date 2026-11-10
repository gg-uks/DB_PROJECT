#!/usr/bin/env bash
# 전체 상태 점검 — 아무 서버(curl 가능)에서 실행
H=192.168.56
ok(){ printf "  %-28s %s\n" "$1" "$2"; }
echo "[웹]"
ok "HAProxy → /api/health"      "$(curl -s -o /dev/null -w '%{http_code}' http://$H.10/api/health)"
ok "WEB1 /api/health"            "$(curl -s -o /dev/null -w '%{http_code}' http://$H.11/api/health)"
ok "WEB2 /api/health"            "$(curl -s -o /dev/null -w '%{http_code}' http://$H.12/api/health)"
echo "[Elasticsearch]"
ok "cluster health"              "$(curl -s http://$H.33:9200/_cluster/health | grep -o '"status":"[a-z]*"')"
ok "리뷰 문서 수"                 "$(curl -s http://$H.33:9200/playlog-reviews-v2/_count | grep -o '"count":[0-9]*')"
ok "워드클라우드 source"          "$(curl -s "http://$H.10/api/analytics/games/413150/wordcloud?side=pos" | grep -o '"source":"[a-z]*"')"
echo "[포트]"
for hp in "$H.31:9092 Kafka" "$H.31:6379 Valkey" "$H.21:3306 MySQL-Source" "$H.23:3306 MySQL-Replica" \
          "$H.22:27017 Mongo-1" "$H.24:27017 Mongo-2" "$H.25:27017 Mongo-3"; do
  set -- $hp; host=${1%:*}; port=${1#*:}
  (echo > /dev/tcp/$host/$port) 2>/dev/null && ok "$2 ($1)" "open" || ok "$2 ($1)" "CLOSED"
done
