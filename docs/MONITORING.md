# playlog 모니터링 설정 — 작업 기록 (시간순)

> 작업일: 2026-11-10 (모니터링 구축) · 2026-11-11 (백업 전략 v2 반영)
> 환경: Rocky Linux 10.2 · VM 13대 (192.168.56.x) · Monitor 서버 **192.168.56.42**
> 관련 문서: `claude/backup_monitoring_rocky.md` 8 · 9 · 12장 (상세) · `claude/백업전략.md` (v2 전체) · `claude/작업공유_2026-11-10_백업_모니터링.md`
> 비밀번호 · Slack Webhook은 이 문서에 적지 않음 (`CHANGE_ME_*`로 표기)

---

## 0. 최종 구성 한눈에 보기

```
[각 서버 exporter] ──scrape(15s)──▶ Prometheus(.42:9090) ──▶ Alertmanager(.42:9093) ──▶ Slack
        ▲                                   │
 backup .41 textfile                        └──▶ Grafana(.42:3000) ◀── MySQL datasource(.23:3306)
 (백업 · binlog · cold 지표)                                  ▲
                                                    SSH 터널로만 접속 (방화벽: SSH만 허용)
```

| 구성 요소 | 위치 · 설정 |
|---|---|
| Prometheus | `/usr/local/bin/prometheus`, 설정 `/etc/prometheus/prometheus.yml`, 데이터 `/data/prometheus`, 보관 15일, `--web.enable-lifecycle` |
| Alertmanager | `/etc/alertmanager/alertmanager.yml`, 데이터 `/data/alertmanager`, Webhook 파일 `/etc/alertmanager/slack_webhook` |
| Grafana | 13.3 (rpm), 포트 3000, 대시보드 **"playlog 운영"** (uid `playlog-ops`) — 최종 **v5** |
| 알림 규칙 | 팀원 기존 `alert_rules.yml` (3개) + 이번에 만든 `alert_rules_steam.yml` (14개) = **17개** |
| 설정 반영 | `curl -X POST 127.0.0.1:9090/-/reload` · `curl -X POST 127.0.0.1:9093/-/reload` (재시작 불필요) |

---

## 1. 기존 상태 확인 (11/10 오전)

- Monitor .42는 **팀원이 11/09에 이미 구축**해 둔 상태: Prometheus · Alertmanager · Grafana 설치, node_exporter 13대 · mysqld_exporter 수집 중
- Prometheus 대상은 **호스트명**으로 등록됨 (`mongo-1:9100`, `mysql-replica:9104` …) → Monitor의 `/etc/hosts`에 모든 서버가 있어야 함
- 팀원 알림 규칙 `alert_rules.yml`: InstanceDown · HighMemory · MySQLReplicationStopped
- 방화벽은 SSH만 허용 → Grafana는 SSH 터널로 접속

> 📌 교훈: 새 서버라고 가정하지 말고 **`ps -ef | grep -E 'prom|grafana|alert'` · `ss -tlnp` · `rpm -qa | grep grafana`로 먼저 확인**
> `claude/…` 로 표시된 문서는 작업자 로컬 기록입니다 (저장소에는 없음) · 실제 설정 파일은 [`infra/vm/`](../infra/vm/)

## 2. 설정 덮어쓰기 사고 → API로 복구

**무슨 일**: .42가 비어 있다고 가정하고 새 설치 절차를 진행 → 팀원의 `prometheus.yml` · `prometheus.service` · 바이너리를 덮어씀

**복구 (재시작 없이)** — 실행 중인 Prometheus는 이전 설정을 메모리에 들고 있으므로 API에서 꺼냄
```bash
mkdir -p /root/prom_before
curl -s 127.0.0.1:9090/api/v1/status/config | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["yaml"])' > /root/prom_before/prometheus.yml
curl -s 127.0.0.1:9090/api/v1/status/flags  > /root/prom_before/flags.json
cp /etc/prometheus/prometheus.yml /etc/prometheus/prometheus.yml.mine   # 덮어쓴 버전 보관
\cp -f /root/prom_before/prometheus.yml /etc/prometheus/prometheus.yml
```
- 서비스 파일 복원:
  `ExecStart=/usr/local/bin/prometheus --config.file=/etc/prometheus/prometheus.yml --storage.tsdb.path=/data/prometheus --storage.tsdb.retention.time=15d --web.enable-lifecycle`
- 주의 ① API 덤프는 **펼친 형식**이라 `scrape_configs` 뒤에 `storage:` · `otlp:`가 붙어 있음 → 새 job은 파일 끝이 아니라 **`storage:` 앞**에 넣어야 함
- 주의 ② `cp`가 덮어쓰기 확인(`cp -i` 별칭)을 묻는 사이 붙여넣은 다음 줄이 답으로 들어감 → **`\cp -f`** 사용

## 3. backup .41 — 백업 지표 노출 (textfile collector)

백업 스크립트가 `/var/lib/node_exporter/textfile/*.prom`에 성공 시각 · 크기를 쓰고, node_exporter가 그대로 노출

```bash
cp /etc/systemd/system/node_exporter.service /root/node_exporter.service.orig
# ExecStart 끝에 추가
--collector.textfile.directory=/var/lib/node_exporter/textfile
mkdir -p /var/lib/node_exporter/textfile
systemctl daemon-reload && systemctl restart node_exporter
curl -s localhost:9100/metrics | grep ^backup_
```
- 지표 (v1): `backup_last_success_timestamp_seconds{target}` · `backup_last_size_bytes{target}` · `restore_test_last_success_timestamp_seconds`

## 4. mongo-3 (.25) 추가 반영

- mongo-3에 node_exporter 설치 (mongo-2의 바이너리 · 서비스 파일 복사), 방화벽 9100 ← .42만
- Monitor `/etc/hosts`에 `192.168.56.25 mongo-3` 추가
- `prometheus.yml` node job에 대상 추가
```bash
sed -i 's/^\(\s*\)- mongo-2:9100/&\n\1- mongo-3:9100/' /etc/prometheus/prometheus.yml
```

## 5. MongoDB exporter (3대)

- percona `mongodb_exporter` v0.54, 포트 **9216**
- 각 노드에 모니터링 계정 (mongosh 한 줄로 — 여러 줄 `use` 붙여넣기는 SyntaxError)
```js
db.getSiblingDB("admin").createUser({user:"exporter",pwd:"CHANGE_ME_EXPORTER",roles:[{role:"clusterMonitor",db:"admin"},{role:"read",db:"local"}]})
```
- `/etc/sysconfig/mongodb_exporter` (600)
```
MONGODB_URI=mongodb://exporter:CHANGE_ME_EXPORTER@127.0.0.1:27017/admin?directConnection=true
```
- ExecStart: `--collect-all --web.listen-address=:9216`, `EnvironmentFile=-/etc/sysconfig/mongodb_exporter`
- **문제**: mongo-1 · 2가 `up=0` → **방화벽 9216이 안 열려 있었음** → 3대 모두 9216 ← .42 허용
```bash
firewall-cmd --permanent --add-rich-rule='rule family=ipv4 source address=192.168.56.42 port port=9216 protocol=tcp accept' && firewall-cmd --reload
```
- 주요 지표: `mongodb_up`, `mongodb_rs_myState` (1=PRIMARY, 2=SECONDARY), `mongodb_rs_members_state`

## 6. 알림 규칙 ① — DB · 백업 (`alert_rules_steam.yml`)

- 파일 `/etc/prometheus/alert_rules_steam.yml` 생성 → `prometheus.yml`의 `rule_files`에 추가
```yaml
rule_files:
  - /etc/prometheus/alert_rules.yml          # 팀원 기존
  - /etc/prometheus/alert_rules_steam.yml    # 추가
```
- 작성 전 **실제 지표 이름을 먼저 확인** (`curl -s localhost:9090/api/v1/label/__name__/values | tr ',' '\n' | grep -E 'mongodb_rs|slave|backup'`)
- `promtool check rules` → reload

| 묶음 | 알림 | 조건 | for |
|---|---|---|---|
| steam-db | MongoDown | `mongodb_up == 0` | 1m |
| | MongoNoPrimary | `absent(mongodb_rs_members_state == 1)` | 1m |
| | MySQLReplicationLag | `mysql_slave_status_seconds_behind_source > 30` | 1m |
| | DiskUsageHigh | 디스크 사용률 > 80% | 5m |
| backup | BackupMissing | 백업 성공 26시간 초과 | — |
| | BackupSizeDropped | 크기 `< 0.5 * offset 1d` | — |
| | RestoreTestOverdue | 복원 테스트 35일 초과 | — |

## 7. Grafana — 데이터 소스 · 대시보드 v1~v3

- 로그인 `admin` / `CHANGE_ME_GRAFANA`
- MySQL 데이터 소스 `mysql`: 192.168.56.23:3306, DB `steam`, 사용자 `grafana` (읽기 전용) — mysql-replica 방화벽 3306 ← .42 추가
- 대시보드는 `gen_dash.py`로 JSON 생성 → Grafana에서 Import (`playlog_dashboard.json`, GitHub 보관)

**고친 것**
| 문제 | 해결 |
|---|---|
| `$__timeGroupAlias(CONVERT_TZ(...), '1h')` — 매크로 안 함수의 쉼표 때문에 파싱 오류 | 서브쿼리로 감싸 `t` 컬럼으로 넘김 (아래) |
| MongoDB 역할 변화 state-timeline이 역할이 바뀔 때마다 줄이 갈라짐 | 역할이 라벨에도 들어 있어서 → `max by (instance)` |
| 값 매핑(PRIMARY/SECONDARY 글자)이 1+/2+로 표시 | 생략하기로 결정 |
| 편집 중 Ctrl+Z로 수정 내용 날아감 | JSON v3 다시 Import |
| Import 덮어쓰기 안 됨 | 기존 대시보드 삭제 후 Import |

```sql
-- API 실패율 (시간별)
SELECT $__timeGroupAlias(t, '1h'), api AS metric, ROUND(SUM(status_code <> 200) * 100 / COUNT(*), 1) AS fail_pct
FROM (SELECT CONVERT_TZ(req_at, '+09:00', '+00:00') AS t, api, status_code FROM API_SYNC_LOG) x
WHERE $__timeFilter(t) GROUP BY 1, api ORDER BY 1
```
```promql
# MongoDB 역할 변화 (죽으면 8 = 정지로 표시)
max by (instance) (mongodb_rs_myState) or ((max by (instance) (mongodb_up)) == 0) + 8
```
- 검증: mongo-1 mongod를 껐다 켜서 역할 변화가 타임라인에 찍히는 것 확인

## 8. Grafana 설정 백업

| 시각 | 서버 | 작업 |
|---|---|---|
| 04:20 | monitor .42 | `/usr/local/bin/grafana_snapshot.sh` — `sqlite3 grafana.db ".backup"` → `/var/backup/grafana/grafana.db.gz` |
| 04:30 | backup .41 | `grafana_backup.sh` — 전용 키 `/root/.ssh/grafana_pull`로 가져옴 |

- .42 `authorized_keys`: `from="192.168.56.41",restrict,command="cat /var/backup/grafana/grafana.db.gz" ssh-ed25519 …`

## 9. 미들웨어 exporter (HAProxy · Valkey · Kafka · ES)

공통 설치 함수 `install_exporter()` (rocky 문서 8장): GitHub 최신 릴리스 → `/usr/local/bin` → `restorecon` → 전용 사용자 → systemd(`EnvironmentFile=-/etc/sysconfig/<이름>`) → 방화벽 포트 ← .42만

| 대상 | 서버 | 포트 | 설정 |
|---|---|---|---|
| HAProxy | lb-server | 8404 | **내장 exporter** — `haproxy.cfg`의 `listen stats`에 `http-request use-service prometheus-exporter if { path /metrics }` (백업 `/root/haproxy.cfg.HHMM`), `haproxy -c -f` 확인 후 reload |
| Valkey | mw .31 | 9121 | redis_exporter v1.97, `--redis.addr=redis://localhost:6379`, `/etc/sysconfig/redis_exporter`에 `REDIS_PASSWORD="CHANGE_ME_VALKEY"` (600) |
| Kafka | mw .31 | 9308 | kafka_exporter v1.11, `--kafka.server=192.168.56.31:9092` |
| Elasticsearch | es | 9114 | elasticsearch_exporter v1.11, `--es.uri=http://localhost:9200` (단일 노드라 YELLOW가 정상) |

- 참고: mw의 `valkey.conf`에 `requirepass` · `bind` 줄이 중복돼 있음 (마지막 줄이 적용) — 정리 권장

**Prometheus job 추가** (`storage:` 앞에 python으로 삽입)
```yaml
  - job_name: mongodb
    static_configs: [{ targets: [mongo-1:9216, mongo-2:9216, mongo-3:9216] }]
  - job_name: haproxy
    static_configs: [{ targets: [lb-server:8404] }]
  - job_name: redis
    static_configs: [{ targets: [mw:9121] }]
  - job_name: kafka
    static_configs: [{ targets: [mw:9308] }]
  - job_name: elasticsearch
    static_configs: [{ targets: [es:9114] }]
```
```bash
promtool check config /etc/prometheus/prometheus.yml && curl -X POST 127.0.0.1:9090/-/reload
curl -s localhost:9090/api/v1/targets | grep -o '"health":"[a-z]*"' | sort | uniq -c   # 모두 up
```

## 10. 알림 규칙 ② — 미들웨어

| 묶음 | 알림 | 조건 | for |
|---|---|---|---|
| middleware | WebBackendDown | `haproxy_backend_active_servers{proxy="web_servers"} < 2` | 1m |
| | RedisDown | `redis_up == 0` | 1m |
| | ElasticsearchRed | `elasticsearch_cluster_health_status{color="red"} == 1` | 1m |
| | KafkaConsumerLag | `sum by (consumergroup, topic) (kafka_consumergroup_lag) > 100` | 10m |

## 11. Slack 연결

Discord는 쓰지 않고 Slack으로 결정.

**Webhook은 대화창에 붙이지 않고 서버에서 직접 입력**
```bash
read -rsp 'Slack Webhook URL: ' U; echo; printf '%s' "$U" > /etc/alertmanager/slack_webhook; unset U
chown root:prometheus /etc/alertmanager/slack_webhook; chmod 640 /etc/alertmanager/slack_webhook
wc -c /etc/alertmanager/slack_webhook     # 81 (여러 번 붙여넣으면 길이가 이상 → 다시 실행)
```

**`/etc/alertmanager/alertmanager.yml`**
```yaml
route:
  receiver: default
  group_by: ['alertname', 'instance']
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 1h
receivers:
  - name: default
    slack_configs:
      - api_url_file: /etc/alertmanager/slack_webhook
        send_resolved: true
        title: '{{ if eq .Status "firing" }}🔴 [발생]{{ else }}✅ [해결]{{ end }} {{ .CommonLabels.alertname }}'
        text: |-
          {{ range .Alerts }}• {{ .Annotations.summary }}  (심각도: {{ .Labels.severity }}, 대상: {{ .Labels.instance }})
          {{ end }}
```
```bash
amtool check-config /etc/alertmanager/alertmanager.yml && curl -X POST 127.0.0.1:9093/-/reload
# 테스트 알림 → Slack에 [발생], 5분 뒤 endsAt 지나면 [해결]
curl -XPOST -H 'Content-Type: application/json' 127.0.0.1:9093/api/v2/alerts -d \
 '[{"labels":{"alertname":"SlackTest","severity":"warning","instance":"test"},"annotations":{"summary":"Slack 연결 테스트"},"endsAt":"'$(date -u -d '+5 min' +%FT%TZ)'"}]'
```

**알림이 오는 방식**
| 설정 | 의미 |
|---|---|
| `for` | 조건이 그 시간 동안 계속돼야 발생 (순간 튐 무시) |
| group_wait 30s | 첫 알림은 30초 모아서 한 번에 |
| group_interval 5m | 같은 묶음에 새 알림이 붙으면 5분 간격 |
| repeat_interval 1h | 해결 안 되면 1시간마다 다시 |
| send_resolved | 해결되면 ✅ [해결] 메시지 |

## 12. 대시보드 v4 — 웹 · 미들웨어 구역 (11/10 완료, 30개 패널)

| 구역 | 패널 |
|---|---|
| 한눈에 보기 | 서버 UP 수 · MongoDB PRIMARY · MySQL 복제 지연 · 마지막 백업 이후 · 발생 중 알림 (stat 5) |
| 백업 · 복원 | 백업 경과 · 크기 · 복원 테스트 경과 |
| DB 복제 · 클러스터 | MongoDB 역할 변화(state-timeline) · MySQL 복제 지연 · CPU · 메모리 |
| 웹 · 미들웨어 | WEB 서버 수 · Valkey 상태 · ES 상태(`green*1 + yellow*2 + red*3`) · Kafka lag(stat · 시계열) · 캐시 적중률 · HAProxy 초당 요청 |
| 데이터 수집 | MySQL 쿼리 패널 (API 실패율 등) |

**11/10 마감 확인**: Prometheus 대상 전부 UP · 알림 14개 · Slack [발생]/[해결] 수신 · 대시보드 정상

---

## 13. 백업 전략 v2 반영 (11/11, 다른 세션 작업)

백업 v2(binlog 실시간 전송 · GFS 보관 계층 · 월 1회 오프라인 백업)에 맞춰 모니터링에 추가된 것.

### 13-1. 새 지표 (backup .41 textfile)

| 파일 | 지표 | 만드는 것 |
|---|---|---|
| `backup_rotate.prom` | `backup_archive_files{tier,target}`, `backup_rotate_last_success_timestamp_seconds` | `backup_rotate.sh` (매일 05:00) |
| `backup_binlog.prom` | `backup_binlog_stream_up` (서비스 active **그리고** .21:3306 연결 중일 때만 1), `backup_binlog_last_write_timestamp_seconds`, `backup_binlog_files`, `backup_binlog_bytes` | `binlog_metrics.sh` (5분마다) |
| `backup_cold_mongo.prom` · `backup_cold_mysql.prom` | `backup_cold_last_success_timestamp_seconds{target}`, `backup_cold_size_bytes{target}` | `cold_pull.sh` (매월 1일 05:20) |

- GFS 정리가 실패하면 성공 시각을 갱신하지 않고 **이전 값을 유지** → 알림이 저절로 사라지지 않음

### 13-2. 알림 3개 추가 → 총 17개

백업: `/root/prom_before/alert_rules_steam.yml.1111_1712`

```yaml
      - alert: BinlogStreamDown
        expr: backup_binlog_stream_up == 0 or time() - node_textfile_mtime_seconds{file=~".*backup_binlog.prom"} > 900
        for: 10m
        labels: { severity: critical }
        annotations:
          summary: "MySQL binlog 실시간 전송 10분 넘게 중단 (이 구간은 시점 복구 불가)"

      - alert: ColdBackupMissing
        expr: time() - backup_cold_last_success_timestamp_seconds > 35 * 86400
        labels: { severity: warning }
        annotations:
          summary: "{{ $labels.target }} 오프라인 백업 35일 넘게 성공 기록 없음"

      - alert: BackupRotateMissing
        expr: time() - backup_rotate_last_success_timestamp_seconds > 26 * 3600
        labels: { severity: warning }
        annotations:
          summary: "백업 보관 계층(GFS) 정리 26시간 넘게 성공 기록 없음"
```
- BinlogStreamDown의 `node_textfile_mtime_seconds` 조건: 지표 cron이 죽으면 마지막 값 `1`이 계속 남아 "정상"으로 보이는 문제를 막음
- `BackupMissing`은 **수정 불필요** — cold 백업이 별도 지표라 오탐 없음
- `promtool`의 "14 rules found"는 `alert_rules_steam.yml` 한 파일 기준 (팀원 파일 3개 합쳐 17개)

### 13-3. 오프라인 백업 중 알림 자동 묵음

매월 1일 05:00 mongo-3 · mysql-replica가 10~20초 멈출 때 MongoDown · InstanceDown 등이 울리지 않도록, **각 서버의 `cold_backup.sh`가 직접 Alertmanager에 15분 묵음 등록**

```bash
AM=http://192.168.56.42:9093
MATCH='(mongo-3|192.168.56.25)(:.*)?'          # mysql-replica: '(mysql-replica|192.168.56.23)(:.*)?'
BODY=$(printf '{"matchers":[{"name":"instance","value":"%s","isRegex":true,"isEqual":true}],"startsAt":"%s","endsAt":"%s","createdBy":"cold_backup.sh","comment":"monthly cold backup"}' \
  "$MATCH" "$(date -u +%FT%TZ)" "$(date -u -d '+15 min' +%FT%TZ)")
curl -s -m 5 -X POST -H 'Content-Type: application/json' -d "$BODY" $AM/api/v2/silences
```
- instance 라벨이 `호스트명:포트`(mongo-3:9216, mysql-replica:9104)라서 정규식에 `(:.*)?` 포함 — Prometheus에서 실제 값 확인함
- 묵음 실패해도 백업은 계속 진행 (WARN만 기록)
- mysql-replica 상태 확인은 기존 exporter 계정 파일 `/etc/.mysqld_exporter.cnf` 재사용 (Replica에 새 계정을 만들면 errant GTID 발생)
- 확인: `curl -s 127.0.0.1:9093/api/v2/silences | python3 -m json.tool | grep -E 'comment|state'`

### 13-4. 대시보드 v5

"백업 · 복원" 구역에 한 줄 추가
- **binlog 실시간 전송** (정상 / 중단)
- **마지막 binlog 기록 이후**
- **마지막 오프라인 백업 이후** (일, mongo · mysql)
- **보관 계층(GFS) 파일 수 표** — 행 mysql/mongo/grafana × 열 주/월/분기/반기/연, 🔒 = 암호화 계층
- 첫 Import에서 GFS 표가 작아 일부 행 · 열이 가려짐 → 높이 6 · 칸 너비 조정한 수정본으로 다시 Import

---

## 14. 최종 참고표

### 14-1. 수집 대상 (Prometheus job)

| job | 대상 | 포트 |
|---|---|---|
| node | 13대 (mongo-1~3, mysql-source, mysql-replica, lb-server, web, mw, es, backup, monitor …) | 9100 |
| mysql | mysql-source · mysql-replica | 9104 |
| mongodb | mongo-1 · mongo-2 · mongo-3 | 9216 |
| haproxy | lb-server | 8404 |
| redis | mw | 9121 |
| kafka | mw | 9308 |
| elasticsearch | es | 9114 |

### 14-2. 알림 17개

| 파일 · 묶음 | 알림 | 심각도 |
|---|---|---|
| `alert_rules.yml` (팀원) | InstanceDown (`up == 0`, 1m) · HighMemory (>90%, 5m) · MySQLReplicationStopped (IO/SQL 정지, 30s) | — |
| steam-db | MongoDown · MongoNoPrimary · MySQLReplicationLag · DiskUsageHigh | critical / warning |
| backup | BackupMissing · BackupSizeDropped · RestoreTestOverdue · **BinlogStreamDown** · **ColdBackupMissing** · **BackupRotateMissing** | 〃 |
| middleware | WebBackendDown · RedisDown · ElasticsearchRed · KafkaConsumerLag | 〃 |

### 14-3. 열어 둔 방화벽 (모두 출발지 .42만)

| 서버 | 포트 |
|---|---|
| 전 서버 | 9100 |
| mongo-1 · 2 · 3 | 9216 |
| mysql-source · replica | 9104, (replica) 3306 — Grafana 데이터 소스 |
| lb-server | 8404 |
| mw | 9121, 9308 |
| es | 9114 |

### 14-4. Grafana 접속

- MobaXterm: Tunneling → 로컬 3000 → 192.168.56.42:127.0.0.1:3000
- 같은 LAN의 다른 PC (NAT GW 경유):
```bash
ssh -J root@192.168.0.224 -L 3000:127.0.0.1:3000 root@192.168.56.42
# 브라우저 http://localhost:3000
```

---

## 15. 바뀐 파일 · 되돌리기

| 서버 | 파일 | 이전판 |
|---|---|---|
| .42 | `/etc/prometheus/prometheus.yml` | `/root/prom_before/prometheus.yml` (API 덤프), `.mine` |
| .42 | `/etc/systemd/system/prometheus.service` | `/root/prom_before/flags.json` 기준 복원 |
| .42 | `/etc/prometheus/alert_rules_steam.yml` | `/root/prom_before/alert_rules_steam.yml.1111_1712` (v2 전) |
| .42 | `/etc/alertmanager/alertmanager.yml` · `slack_webhook` | 신규 |
| .42 | `/usr/local/bin/grafana_snapshot.sh`, `authorized_keys` (grafana_pull) | 신규 |
| .41 | node_exporter.service (textfile 옵션) | `/root/node_exporter.service.orig` |
| lb-server | `/etc/haproxy/haproxy.cfg` | `/root/haproxy.cfg.HHMM` |
| mongo-1~3 · mw · es | exporter 서비스 · `/etc/sysconfig/*` | 신규 (`systemctl disable --now`로 제거) |

---

## 16. 겪은 문제와 교훈

| 문제 | 원인 | 해결 · 교훈 |
|---|---|---|
| 팀원 설정 덮어씀 | 빈 서버라고 가정 | API(`status/config`, `flags`)로 복구 → **먼저 확인** |
| 새 job이 적용 안 됨 | 덤프 파일에서 `storage:` 뒤에 추가 | `storage:` 앞에 삽입 |
| `cp` 확인 질문에 다음 줄이 들어감 | `cp -i` 별칭 + 여러 줄 붙여넣기 | `\cp -f` |
| mongo-1 · 2 exporter `up=0` | 방화벽 9216 누락 | rich rule 추가 |
| 복원 테스트 docs=0 | MongoDB 앱 DB는 `steam`이 아니라 **`playlog`** | 스크립트 · 문서 전부 정정 |
| Grafana 매크로 오류 | 매크로 안 함수의 쉼표 | 서브쿼리 |
| state-timeline 줄 갈라짐 | 역할이 라벨에 포함 | `max by (instance)` |
| mongosh SyntaxError | 여러 줄 `use` 붙여넣기 | `getSiblingDB` 한 줄 |
| `^[[200~` 문자 | bracketed paste | 그 줄 다시 실행 |
| Webhook 파일 길이 이상 | 안 보이는 입력에 여러 번 붙여넣음 | 다시 실행, `wc -c`로 확인 |
| binlog 상태가 계속 "정상"일 위험 | cron이 죽으면 textfile 마지막 값 유지 | `node_textfile_mtime_seconds` 조건 |
| 오프라인 백업 중 알림 폭주 위험 | 의도된 정지 | 스크립트가 Alertmanager 15분 묵음 |

## 17. 트러블슈팅

| 증상 | 확인 |
|---|---|
| 대상 DOWN | 해당 서버 `systemctl status <exporter>` → `curl localhost:<포트>/metrics` → 방화벽 → Monitor `/etc/hosts` |
| 알림이 안 울림 | `localhost:9090/alerts`에서 pending/firing 여부 → `amtool alert` → Alertmanager 로그 |
| Slack 메시지 없음 | `journalctl -u alertmanager | grep -i slack`, `wc -c slack_webhook`, 권한 640 root:prometheus |
| 백업 지표 없음 | .41 `ls -l /var/lib/node_exporter/textfile/`, node_exporter에 textfile 옵션 |
| 묵음이 안 걸림 | `curl -s .42:9093/api/v2/silences`, instance 라벨 실제 값과 정규식 비교 |
| Grafana MySQL 패널 오류 | 데이터 소스 Test, mysql-replica 3306 ← .42 |

## 18. 남은 일

- [ ] `backup_monitoring_rocky.md` 트러블슈팅의 "Discord" 줄 → Slack으로 정정
- [ ] 대시보드 v5 GitHub 커밋 (높이 조정본)
- [ ] 발표 31장 알림 17개 반영
- [ ] 2026-12-01 첫 월간 오프라인 백업 때 **묵음 등록 · Slack 무알림** 확인, 대시보드 "마지막 오프라인 백업 이후" 0일 확인
- [ ] 2026-11-15(일) 첫 weekly 승격 후 GFS 표 값 확인
- [ ] (선택) 단일 장애점 보완: Monitor .42 자체 감시 없음 — Slack이 조용하면 Monitor가 죽었을 수도 있음 (Watchdog 알림 고려)
