# playlog 백업 전략 v2 — 작업 정리

> 작업일: 2026-11-11 (10:39 ~ 18:50) · 환경: Rocky Linux 10.2 · VM 13대 (192.168.56.x) · MySQL 8.4.11 · MongoDB 8.0.34
> 근거 계획: `claude/백업전략_v2_작업계획.md` 3장 (① GFS → ② binlog → ③ 오프라인 → ④ 알림 · 대시보드 → ⑤ 다른 장비 사본 → ⑥ 문서)
> 상세 운영 문서: `claude/backup_monitoring_rocky.md` 12장 · 팀 공유: `claude/작업공유_2026-11-11_백업전략v2.md`
> `claude/…` 로 표시된 문서는 작업자 로컬 기록입니다 (저장소에는 없음) · 실제 설정 파일은 [`infra/vm/`](../infra/vm/)

---

## 1. 한눈에 보기

### 1-1. 무엇이 바뀌었나

| 기준 | 전 (v1) | **후 (v2)** |
|---|---|---|
| 전체 / 증분 | 매일 전체 덤프만 | 매일 전체 + **MySQL binlog 실시간 전송 (증분)** |
| 온라인 / 오프라인 | 온라인(hot)만 | 온라인 매일 + **오프라인(cold) 월 1회** — mongo-3 · mysql-replica만 몇 초 정지 |
| 보관 주기 | 일 7개 | **일 7 → 주 4 → 월 12 → 분기 4 → 반기 2 → 연 3 (GFS)**, 분기 이상 암호화 |
| 다른 장비 사본 | 없음 | **주 1회 호스트 PC** (`D:\playlog_backup`) |
| 검증 | 월 1회 복원 테스트 | 복원 테스트 + **시점 복구(PITR) 검사** |
| 알림 | 14개 | **17개** |
| 대시보드 | v4 | **v5** (백업 패널 4개 추가) |

### 1-2. 데이터별 복구 목표 (RPO)

| 데이터 | 다시 만들 수 있나 | 전 | **후** |
|---|---|---|---|
| 회원 · 찜 (MySQL MEMBER · WISHLIST) | ❌ | 최대 24시간 | **거의 0** (binlog 시점 복구) |
| 게임 · 리뷰 메타 (MySQL), 리뷰 원본 (Mongo) | ⭕ Steam API 재수집 | 1일 | 1일 |
| Elasticsearch | ⭕ 재색인 | 백업 안 함 | 백업 안 함 |
| Grafana 설정 | △ JSON은 GitHub | 1일 | 1일 |

### 1-3. 최종 일정

| 시각 | 서버 | 작업 | 종류 |
|---|---|---|---|
| 상시 | backup .41 | `mysql-binlog-stream` — Source binlog 실시간 수신 | 증분 · 온라인 |
| 5분마다 | .41 | `binlog_metrics.sh` — 전송 상태 지표 | 감시 |
| 매일 04:00 / 04:10 / 04:30 | .41 | MySQL / MongoDB / Grafana 전체 백업 (기존) | 전체 · 온라인 |
| 매일 05:00 | .41 | `backup_rotate.sh` — GFS 승격 · 정리 + 오래된 binlog 정리 | 보관 |
| 매월 1일 05:00 | mongo-3 .25 · mysql-replica .23 | `cold_backup.sh` — 정지 → 데이터 폴더 묶기 → 시작 | 전체 · 오프라인 |
| 매월 1일 05:20 | .41 | `cold_pull.sh` — 오프라인 백업 가져오기 (전용 키) | 수집 |
| 매월 1일 05:30 | .41 | `restore_test.sh` v2 — 복원 테스트 + PITR 검사 | 검증 |
| 매주 (수동) | 호스트 PC | archive · cold 복사 | 3-2-1 |

---

## 2. 단계별 작업 기록

### ① 보관 계층 (GFS) — backup .41

**현재 상태 확인에서 발견한 것**
- 디스크는 계획서의 80GB가 아니라 **30GB** (sda 30G, `/`=rl-root 27G). `/backup`도 루트에 있음 → 모든 백업 폴더가 같은 파일시스템이라 **하드링크 가능**
- `steam_20261109_2001.sql.gz`가 583바이트 — 초기 테스트 실패 파일 (7일 뒤 자동 삭제, 승격 대상 아님)

**만든 것**
- 폴더 `/backup/archive/{weekly,monthly,quarterly,half,yearly}/{mysql,mongo,grafana}` (700)
- 암호화 키 `/root/.backup_archive.key` (600, `openssl rand -base64 32`, 45바이트)
- `/usr/local/bin/backup_rotate.sh [YYYY-MM-DD]` + cron `0 5 * * *`

**규칙**
- 일요일 → weekly, 매월 1일 → monthly, 1·4·7·10월 1일 → quarterly, 1·7월 1일 → half, 1월 1일 → yearly
- weekly · monthly는 **하드링크** (공간 거의 0, 일일 파일이 지워져도 남음)
- quarterly 이상은 **AES-256 암호화 → 복호화해서 원본과 비교 → 저장** (장기 보관본에 회원 정보)
- 계층별 개수로 정리: 4 / 12 / 4 / 2 / 3
- 승격일인데 일일 백업이 없으면 WARN + 종료코드 1 + **성공 시각 갱신 안 함** (실패해도 이전 성공 시각은 유지 → 알림이 사라지지 않음)
- 지표: `backup_archive_files{tier,target}`, `backup_rotate_last_success_timestamp_seconds`

**검증**
- `BACKUP_ROOT=/tmp/gfs_test` 로 2026-01-01 ~ 2027-01-10 가짜 백업을 하루씩 돌림 → weekly 4 · monthly 12 · quarterly 4 · half 2 · yearly 2, 하드링크 수 2, `.enc` 600 · 복호화 성공, FAIL 0
- 누락 테스트 (2027-01-17 일요일, mongo 없음) → mongo만 WARN, 종료코드 1, success 시각 유지
- 실제 실행 → "승격 대상 계층 없음 (정리만)", node_exporter로 지표 노출 확인

### ② MySQL 증분 — binlog 실시간 전송 + 시점 복구

**사전 확인 (mysql-source .21)**
| 항목 | 값 |
|---|---|
| log_bin · gtid_mode · enforce_gtid_consistency | ON |
| binlog_format / row_image | ROW / FULL |
| binlog 보관 | 2592000 (30일) |
| server_id | 1 |
| binlog 파일 | `mysql-bin.000001` ~ `000004` (첫 파일부터 남아 있음) |
| gtid_executed | `23dad2da-…:1-8070` |

- backup 서버에 `mysqlbinlog` 8.4.11 있음, mysqldump가 `--set-gtid-purged=COMMENTED` 지원
- mysql-source root 비밀번호는 문서에 없음 → 사용자가 직접 입력

**권한 추가 (mysql-source, Replica로 복제됨)**
```sql
GRANT REPLICATION SLAVE ON *.* TO 'backup'@'192.168.56.41';
GRANT FLUSH_TABLES ON *.* TO 'backup'@'192.168.56.41';
GRANT REPLICATION_APPLIER, SESSION_VARIABLES_ADMIN ON *.* TO 'restore'@'192.168.56.41';
```

**만든 것 (backup .41)**
- `/root/.binlog.cnf` = `.backup.cnf`에서 host만 mysql-source로 (비밀번호 재입력 없음)
- `/usr/local/bin/mysql_binlog_stream.sh` + `mysql-binlog-stream.service` (Restart=always 10초, enabled)
  - 받은 파일이 있으면 **가장 최신 파일부터 다시**(덮어씀), 없으면 Source의 가장 오래된 파일부터
  - `mysqlbinlog --read-from-remote-server --raw --stop-never --connection-server-id=4101`
- `/usr/local/bin/binlog_metrics.sh` + cron `*/5` — `backup_binlog_stream_up`은 서비스 active **그리고** .21:3306 연결 중일 때만 1
- `backup_rotate.sh`에 binlog 정리 추가 — **7일 경과 그리고 가장 오래된 MySQL 일일 백업보다 먼저 끝난 파일만**, 최신 파일은 항상 남김

**검증**
- 서비스 시작 → `000001`~`000004` 수신, 크기 Source와 동일. 직전 GRANT로 `000004`가 234바이트 늘어난 것까지 반영
- Source `FLUSH BINARY LOGS` → 같은 초(13:30:28)에 `000005` 생성
- 서비스 재시작 → `시작 파일: mysql-bin.000005` (처음부터 다시 받지 않음)
- 서비스 중지 → 지표 0, 재시작 → 1

**덤프 옵션 변경** (사용자 결정: 지금 바꾸고 황시영 님께 사후 공유)
- `mysql_backup.sh`: `--set-gtid-purged=OFF` → **`COMMENTED`** (이전판 `.v1`, 원본 `.orig`)
- 첫 실행 실패: `Couldn't execute 'FLUSH TABLES': Access denied; you need RELOAD or FLUSH_TABLES` → 넓은 `RELOAD` 대신 **`FLUSH_TABLES`** 권한만 추가 → 성공
- 덤프 맨 위에 `/* SET @@GLOBAL.GTID_PURGED='+23dad2da-…:1-8072, 55706265-…:1-2';*/` (주석이라 기존 복원 방식 그대로)
- 📌 **발견**: `55706265-…:1-2`는 **Replica 자신의 UUID** → Replica에서 직접 실행된 트랜잭션 2개 (errant GTID). PITR엔 영향 없음, Replica 승격 시 주의

**PITR 리허설 (14:20)** — 테스트 회원 INSERT → 3초 뒤 DELETE (사고)
| 확인 | 결과 |
|---|---|
| 덤프 GTID | `23dad2da-…:1-8072, 55706265-…:1-2` |
| 사고(DELETE) GTID | `23dad2da-…:8075` |
| restore_test.MEMBER | `pitr_test@playlog.local` (member_id 4) **부활** |
| MEMBER 건수 | 복구본 4 = 운영 3 + 1 |
| REVIEW 건수 | 7493 = 7493 |
| Replica에 restore_test | 없음 (복구 작업이 복제되지 않음) |

**복원 테스트 v2** — 기존 `restore_test.sh`의 문제와 수정
- 문제: v1은 복원 작업을 binlog에 기록 → 05:30 복원 테스트 이후 사고가 나면 PITR 중 "restore_test 테이블 생성"이 다시 실행돼 **"이미 있는 테이블" 오류로 복구 중단**
- 수정: 복원 · 삭제 모두 `SET sql_log_bin=0`, 덤프 이후 binlog 전부 적용 → 운영(Replica)과 MEMBER · REVIEW 건수 비교 (이전판 `.v1`)
- 실행 결과: `OK mysql=steam_20261111_1416.sql.gz tables=15 reviews=7493 pitr=member:3/3,review:7493/7493 | mongo=rs0_20261111_0410.archive.gz docs=7523`

### ③ 오프라인(cold) 백업 — mongo-3 · mysql-replica

**사전 확인**
| | mongo-3 (.25) | mysql-replica (.23) |
|---|---|---|
| 상태 | active, SECONDARY | active, super_read_only ON |
| 데이터 폴더 | 242MB | 253MB |
| 디스크 여유 | 24GB | 25GB |
| Alertmanager(.42:9093) 접근 | 200 | 200 |

- 열린 질문 1 결론: **mysql-replica 정지 중 앱 읽기 실패 허용** (사용자 결정)
- Alertmanager에 직접 닿으므로 **각 서버가 스스로 알림 묵음** 등록

**설계 — 계획서보다 보강한 점**
- mongo-3: SECONDARY인지뿐 아니라 **멤버 3대 모두 정상인지** 확인 (1대가 이미 죽어 있는데 멈추면 과반이 깨져 PRIMARY가 내려감). 인증이 필요 없는 `hello`로 각 멤버 확인
- mysql-replica: 복제 IO · SQL Yes, 지연 60초 이하일 때만. 상태 확인은 기존 `exporter@localhost`(`/etc/.mysqld_exporter.cnf`) 재사용 — **Replica에서 계정을 새로 만들면 errant GTID가 또 생김**. `STOP REPLICA` 불필요 (정상 종료 + GTID 자동 위치)
- 알림 묵음 15분: `instance=~"(mongo-3|192.168.56.25)(:.*)?"` 등 — 실제 instance 이름이 `호스트명:포트`(mongo-3:9216, mysql-replica:9104)임을 Prometheus에서 확인
- `trap`으로 **무슨 일이 있어도 다시 시작**, `tar --selinux --acls --xattrs`로 SELinux 라벨 보존
- 원격 `cold_send.sh`는 **24시간 이내 파일만** 내보냄 → 이번 달 실패 시 지난달 파일을 "성공"으로 가져가지 않음
- .41 전용 키 `cold_pull`: `from="192.168.56.41",restrict,command="/usr/local/bin/cold_send.sh"`

**실행 결과 (17:00 ~ 17:10)**
| | mongo-3 | mysql-replica |
|---|---|---|
| 정지 시간 | 17초 | 8초 |
| 압축본 | 32MB (`mongo_202611.tar.gz`) | 34MB (`mysql_202611.tar.gz`) |
| 복귀 | SECONDARY | 복제 IO · SQL Yes, 지연 0 |
| 묵음 | 등록 · active | 등록 |
| .41로 가져오기 | OK | OK |
| 키 제한 | `ls /` 무시, gzip(`1f 8b`)만 출력 | 〃 |

- `PTY allocation request failed` 경고 → `restrict` 때문의 무해한 경고, `ssh -T`로 제거

### ④ 알림 · 대시보드 — monitor .42

**알림 규칙** (`alert_rules_steam.yml` backup 묶음, 백업 `/root/prom_before/alert_rules_steam.yml.1111_1712`)
| 알림 | 조건 | 심각도 |
|---|---|---|
| BinlogStreamDown | `backup_binlog_stream_up == 0` **또는** binlog 지표 파일 15분 미갱신 (cron이 죽어 마지막 값 1이 남는 경우), 10분 | critical |
| ColdBackupMissing | 오프라인 백업 35일 초과 (target별) | warning |
| BackupRotateMissing | GFS 정리 26시간 초과 | warning |

- `BackupMissing`은 **수정 불필요** — 계획서는 cold를 같은 지표에 target으로 넣을 예정이라 오탐을 걱정했으나, 실제로는 별도 지표(`backup_cold_…`)로 만듦
- 결과: 전체 17개, backup 묶음 6개 모두 `inactive - ok` (`promtool`의 "14 rules found"는 그 파일 하나의 개수)

**대시보드 v5** (`playlog_dashboard.json`) — "백업 · 복원" 구역에 한 줄 추가
- binlog 실시간 전송 (정상/중단) · 마지막 binlog 기록 이후 · 마지막 오프라인 백업 이후 (일, mongo · mysql) · 보관 계층(GFS) 파일 수 표 (🔒 = 암호화)
- 첫 Import에서 GFS 표가 작아 mysql 행 · 반기 · 연 열이 가려짐 → 높이 · 칸 너비만 조정한 수정본 재전달

### ⑤ 다른 장비 사본 (3-2-1) — 호스트 PC

```powershell
New-Item -ItemType Directory -Force D:\playlog_backup
scp -r root@192.168.56.41:/backup/archive D:\playlog_backup\
scp -r root@192.168.56.41:/backup/cold D:\playlog_backup\
```
- 결과: `cold\mongo\mongo_202611.tar.gz` 32615413, `cold\mysql\mysql_202611.tar.gz` 35306327 — 서버와 바이트 단위 일치

**암호화 키 보관 — 처음 안에서 바꾼 결정**
- 처음 제안: 호스트 PC의 다른 폴더 → 사용자 지적 ("VM 안 깔린 다른 기기여야 하지 않나")
- 맞는 지적: 호스트 PC에는 암호화본이 같이 있어 **같이 털리면 암호화 의미 없음**, VM도 호스트 위에 있어 **고장 나면 원본 키와 사본 키가 동시에 사라짐**
- 결론: **비밀번호 관리자**에 키 문자열 + 확인용 sha256 앞 12자리 저장. GitHub 금지
- 키가 화면 캡처로 대화에 노출됨 → 아직 암호화본이 없어 교체 비용 0이었으나 실습 환경이라 **교체하지 않기로** (실서비스라면 교체)
- 한계: 호스트 PC 사본은 VM 디스크와 다른 저장 장치일 뿐, 도난 · 화재까지 막는 진짜 외부 보관은 아님 → 실서비스라면 외장 디스크 · 클라우드 스토리지(S3)

### ⑥ 문서

| 문서 (프로젝트) | 내용 |
|---|---|
| `claude/backup_monitoring_rocky.md` | 12장 "백업 전략 v2" 추가 (스크립트 전체 · PITR · 오프라인 복원 절차), 기존 장(디스크 · 3장 옵션 · 6장 RPO · 7장 v2 스크립트 · 9장 알림 17개 · 대시보드 v5 · 10장 체크리스트 · 시연 ⑤ · 11장 발표 · 트러블슈팅) 갱신 |
| `claude/작업공유_2026-11-11_백업전략v2.md` | 팀 공유 요약, 황시영 님 확인 사항, 발표 수정안 |
| `claude/백업전략_v2_진행기록.md` | 진행 상태 · 결정 · 남은 일 |

---

## 3. 결정 사항 (열린 질문 결론)

| # | 질문 | 결론 |
|---|---|---|
| 1 | mysql-replica 오프라인 백업 중 앱 읽기 실패 허용? | **허용** (매월 1일 05:00, 약 10초) |
| 2 | 장기 보관 암호화 키 위치 | **비밀번호 관리자** (호스트 PC · GitHub 아님) |
| 3 | `mysql_backup.sh` 덤프 옵션 변경 | **지금 변경, 황시영 님께 사후 공유** |
| 4 | 호스트 PC 사본 경로 | `D:\playlog_backup` |

---

## 4. 시점 복구 (PITR) 절차

```bash
# backup .41
MY=/root/.my-restore.cnf
F=$(ls -t /backup/mysql/steam_*.sql.gz | head -1)

# ① 덤프의 GTID = binlog를 어디서부터 적용할지
DUMP_GTID=$(zcat $F | head -40 | tr -d '\n' | grep -oP "GTID_PURGED='\+?\K[^']+")

# ② 사고(DELETE)의 GTID (시각을 알면 --stop-datetime='YYYY-MM-DD HH:MM:SS'로 대신)
DEL_GTID=$(mysqlbinlog -v --base64-output=decode-rows /backup/binlog/mysql-bin.[0-9]* 2>/dev/null \
  | awk -F"'" '/GTID_NEXT=/{g=$2} /^### DELETE FROM `steam`.`MEMBER`/{print g}' | tail -1)

# ③ 전체 백업 → restore_test (binlog에 남기지 않음)
( echo "SET sql_log_bin=0;"; zcat $F | sed -e 's/DEFINER=`[^`]*`@`[^`]*`//g' -e 's/`steam`/`restore_test`/g' ) \
  | mysql --defaults-extra-file=$MY

# ④ binlog 적용: 덤프 이후 ~ 사고 직전
mysqlbinlog --skip-gtids --disable-log-bin --exclude-gtids="$DUMP_GTID,$DEL_GTID" \
  --rewrite-db='steam->restore_test' --database=restore_test /backup/binlog/mysql-bin.[0-9]* \
  | mysql --defaults-extra-file=$MY

# ⑤ 확인 → (Source root) 필요한 행만 운영에 되돌림 → 정리
#    INSERT INTO steam.MEMBER SELECT * FROM restore_test.MEMBER WHERE email='…';
mysql --defaults-extra-file=$MY -e "SET sql_log_bin=0; DROP DATABASE restore_test;"
```

| 옵션 | 이유 |
|---|---|
| `--skip-gtids` | 같은 Source에 다시 넣으므로 원래 GTID를 쓰면 "이미 실행됨"으로 **조용히 건너뜀** |
| `--disable-log-bin` · `SET sql_log_bin=0` | 복구 작업이 binlog에 안 남음 → Replica로 복제 안 됨, 다음 PITR에 안 섞임 |
| `--rewrite-db` + `--database=restore_test` | rewrite **후** 이름으로 거름 → GRANT 등 다른 DB 이벤트 제외 |
| `--exclude-gtids` | 덤프에 이미 있는 것 + 사고 트랜잭션 제외 |

---

## 5. 오프라인 백업 복원 절차

```bash
# ── MySQL (mysql-replica)
systemctl stop mysqld
mv /var/lib/mysql /var/lib/mysql.broken.$(date +%m%d)
tar --selinux --acls --xattrs -xzf mysql_YYYYMM.tar.gz -C /var/lib
chown -R mysql:mysql /var/lib/mysql; restorecon -R /var/lib/mysql
systemctl start mysqld
# GTID 자동 위치로 복제 재개 — Source binlog 보관(30일)보다 오래된 사본이면 덤프로 재구축
# 다른 서버에 새 Replica로 쓸 때는 auto.cnf 삭제 · server_id 변경

# ── MongoDB (mongo-3)
systemctl stop mongod
mv /var/lib/mongo /var/lib/mongo.broken.$(date +%m%d)
tar --selinux --acls --xattrs -xzf mongo_YYYYMM.tar.gz -C /var/lib
chown -R mongod:mongod /var/lib/mongo; restorecon -R /var/lib/mongo
systemctl start mongod
# rs0에 다시 붙어 oplog로 따라잡음. oplog 범위보다 오래되면 "too stale" → 데이터 폴더 비우고 시작 (initial sync)
```

---

## 6. 겪은 문제와 해결

| 문제 | 원인 | 해결 |
|---|---|---|
| 계획서 디스크 80GB ≠ 실제 30GB | 계획서 오류 | 문서 정정, 용량은 충분 (1년 cold 약 800MB) |
| mysql-source root 비밀번호 모름 | 문서에 없음 (원칙상 안 적음) | 조회는 backup 계정으로, GRANT는 사용자가 직접 로그인 |
| `COMMENTED` 덤프 `Access denied … RELOAD or FLUSH_TABLES` | GTID를 정확히 찍으려고 짧은 FTWRL 사용 | 좁은 권한 `FLUSH_TABLES`만 추가 (그대로 뒀으면 그날 밤 04:00 덤프 실패) |
| v1 복원 테스트가 PITR을 망가뜨릴 수 있음 | 복원 작업이 binlog에 기록됨 | `sql_log_bin=0` + `--skip-gtids` · `--disable-log-bin` |
| 같은 서버에 binlog 재적용 시 건너뜀 위험 | GTID가 이미 실행된 것으로 처리 | `--skip-gtids` |
| Replica에서 계정 생성 시 errant GTID | super_read_only Replica에 직접 쓰기 | 기존 `exporter@localhost` 설정 파일 재사용 |
| 오프라인 백업이 지난달 파일을 "성공"으로 가져갈 위험 | `latest.tar.gz`가 실패 시 옛 파일을 가리킴 | 원격 `cold_send.sh`가 24시간 이내 파일만 전송 |
| 지표 cron이 죽으면 binlog 상태가 계속 "정상" | textfile 마지막 값 유지 | 알림에 `node_textfile_mtime_seconds` 15분 조건 추가 |
| `PTY allocation request failed` | `restrict` 옵션 | `ssh -T` |
| GFS 표 일부 가려짐 | 패널 높이 부족 | 높이 6 · 칸 너비 조정 |
| 암호화 키를 호스트 PC에 두는 제안 | 암호화본 · VM과 같은 장비 | 비밀번호 관리자로 변경 (사용자 지적) |

---

## 7. 바뀐 파일 · 되돌리기

| 서버 | 파일 | 이전판 / 비고 |
|---|---|---|
| .41 | `/usr/local/bin/mysql_backup.sh` | `.v1` (OFF), `.orig` (황시영 원본) |
| .41 | `/usr/local/bin/restore_test.sh` | `.v1` |
| .41 | `/usr/local/bin/backup_rotate.sh` | `.v1` (binlog 정리 추가 전) — 새로 만든 파일 |
| .42 | `/etc/prometheus/alert_rules_steam.yml` | `/root/prom_before/alert_rules_steam.yml.1111_1712` |
| .23 · .25 | `/root/.ssh/authorized_keys` | `.bak` |
| .21 (→ .23 복제) | MySQL 권한 4개 | `REVOKE …`로 되돌림 |

**새로 만든 것**

| 서버 | 파일 |
|---|---|
| .41 | `backup_rotate.sh` · `mysql_binlog_stream.sh` · `binlog_metrics.sh` · `cold_pull.sh` · `/etc/systemd/system/mysql-binlog-stream.service` · cron `backup_rotate` `binlog_metrics` `cold_pull` · `/root/.binlog.cnf` · `/root/.backup_archive.key` · `/root/.ssh/cold_pull` · `/backup/{archive,binlog,cold}` |
| .25 · .23 | `cold_backup.sh` · `cold_send.sh` · cron `cold_backup` · `/var/backup/cold/` |
| 지표 (.41 textfile) | `backup_rotate.prom` · `backup_binlog.prom` · `backup_cold_mongo.prom` · `backup_cold_mysql.prom` |
| 호스트 PC | `D:\playlog_backup\{archive,cold}` |

---

## 8. 확인 체크리스트 (2026-11-11 모두 통과)

| # | 확인 | 결과 |
|---|---|---|
| 1 | binlog 서비스 | active, Source와 같은 파일 · 크기 |
| 2 | 실시간 · 파일 교체 · 재시작 | 같은 초 반영, 최신 파일부터 이어받음 |
| 3 | PITR | 리허설 성공, 월간 검사 `pitr=member:3/3,review:7493/7493` |
| 4 | GFS 모의 실행 | 4/12/4/2/2, 하드링크 · 암호화 · 누락 WARN |
| 5 | 오프라인 백업 | mongo-3 SECONDARY 복귀, Replica 복제 Yes, .41에 tar.gz, 묵음 |
| 6 | 알림 | 17개 inactive · ok |
| 7 | 대시보드 v5 | 새 패널 정상 |
| 8 | 호스트 PC 사본 | 크기 일치 |
| 9 | 문서 | rocky 12장 · 공유 문서 · 진행 기록 |

---

## 9. 남은 일

- [ ] 황시영 님께 공유 (덤프 옵션 · backup/restore 계정 권한 · errant GTID)
- [ ] 대시보드 v5 GitHub 커밋 (높이 조정본으로 다시 Import)
- [ ] 발표 수정: 29장(백업 전략 표 · RPO 24시간 → 거의 0) · 30장(시연 ⑤ PITR) · 31장(알림 17개) · 33장(한계: 진짜 외부 보관 아님)
- [ ] 2026-11-15(일) 05:00 첫 weekly 승격 확인 — `tail /backup/archive/rotate.log`
- [ ] 2026-12-01 첫 월간 자동 실행 확인 — `cold.log`(.23 · .25) · `/backup/cold/pull.log` · `/backup/restore_test.log`
- [ ] 매주 호스트 PC 사본 (PowerShell 두 줄)

---

## 부록 — 최종 스크립트 전체

### A-1. backup .41 — /usr/local/bin/backup_rotate.sh (매일 05:00)

```bash
#!/bin/bash
# playlog GFS 보관 계층 승격 · 정리 (매일 05:00)
# 사용: backup_rotate.sh [YYYY-MM-DD]        (생략 시 오늘)
# 테스트: BACKUP_ROOT=/tmp/gfs_test METRICS_DIR=/tmp/gfs_test/metrics backup_rotate.sh 2026-11-15
# 복호화: openssl enc -d -aes-256-cbc -pbkdf2 -pass file:/root/.backup_archive.key -in X.enc -out X
set -uo pipefail

BACKUP_ROOT=${BACKUP_ROOT:-/backup}
METRICS_DIR=${METRICS_DIR:-/var/lib/node_exporter/textfile}
KEY=/root/.backup_archive.key
ARCHIVE=$BACKUP_ROOT/archive
LOG=$ARCHIVE/rotate.log

TIERS="weekly monthly quarterly half yearly"
TARGETS="mysql mongo grafana"
declare -A KEEP=([weekly]=4 [monthly]=12 [quarterly]=4 [half]=2 [yearly]=3)
declare -A PREFIX=([mysql]="steam_" [mongo]="rs0_" [grafana]="grafana_")

D=${1:-$(date +%F)}
date -d "$D" +%F >/dev/null 2>&1 || { echo "날짜 형식 오류: $D (YYYY-MM-DD)"; exit 2; }
YMD=$(date -d "$D" +%Y%m%d); DOW=$(date -d "$D" +%u)
MON=$(date -d "$D" +%m);     DAY=$(date -d "$D" +%d)

mkdir -p "$ARCHIVE"
log(){ echo "$(date '+%F %T') [$D] $*" >> "$LOG"; echo "$*"; }

exec 9>/run/backup_rotate.lock
flock -n 9 || { log "이미 실행 중 → 종료"; exit 1; }

# 1) 오늘 승격할 계층
PROMOTE=""
[ "$DOW" = 7 ] && PROMOTE+=" weekly"
if [ "$DAY" = 01 ]; then
  PROMOTE+=" monthly"
  case $MON in 01|04|07|10) PROMOTE+=" quarterly";; esac
  case $MON in 01|07)       PROMOTE+=" half";;      esac
  [ "$MON" = 01 ] && PROMOTE+=" yearly"
fi
[ -z "$PROMOTE" ] && log "승격 대상 계층 없음 (정리만)"

FAIL=0
for tier in $PROMOTE; do
  for t in $TARGETS; do
    src=$(ls -1 "$BACKUP_ROOT/$t/${PREFIX[$t]}${YMD}_"* 2>/dev/null | sort | tail -n 1)
    if [ -z "$src" ]; then
      log "WARN $tier/$t: $YMD 일일 백업 없음 → 승격 안 함"; FAIL=1; continue
    fi
    dir=$ARCHIVE/$tier/$t; mkdir -p "$dir"; name=$(basename "$src")
    case $tier in
      weekly|monthly)
        if ln -f "$src" "$dir/$name"; then log "OK   $tier/$t: $name (하드링크)"
        else log "FAIL $tier/$t: ln 실패"; FAIL=1; fi ;;
      *)
        if [ ! -s "$KEY" ]; then log "FAIL $tier/$t: 키 파일 없음 $KEY"; FAIL=1; continue; fi
        if openssl enc -aes-256-cbc -pbkdf2 -salt -pass file:"$KEY" -in "$src" -out "$dir/$name.enc.tmp" \
           && openssl enc -d -aes-256-cbc -pbkdf2 -pass file:"$KEY" -in "$dir/$name.enc.tmp" | cmp -s - "$src" \
           && mv -f "$dir/$name.enc.tmp" "$dir/$name.enc"; then
          chmod 600 "$dir/$name.enc"; log "OK   $tier/$t: $name.enc (암호화 · 복호화 검증)"
        else
          rm -f "$dir/$name.enc.tmp"; log "FAIL $tier/$t: 암호화/검증 실패"; FAIL=1
        fi ;;
    esac
  done
done

# 2) 계층별 개수 정리 (최근 N개만)
for tier in $TIERS; do
  for t in $TARGETS; do
    dir=$ARCHIVE/$tier/$t; [ -d "$dir" ] || continue
    ls -1 "$dir" | grep -v '\.tmp$' | sort -r | tail -n +$(( ${KEEP[$tier]} + 1 )) | while read -r f; do
      rm -f "$dir/$f" && log "DEL  $tier/$t: $f (보관 ${KEEP[$tier]}개 초과)"
    done
  done
done

# 2-1) binlog 정리: 7일 지났고, 가장 오래된 MySQL 일일 백업보다 먼저 끝난 파일만 (최신 파일은 항상 남김)
BINDIR=$BACKUP_ROOT/binlog
OLDEST=$(ls -1tr "$BACKUP_ROOT"/mysql/steam_*.sql.gz 2>/dev/null | head -n 1)
if [ -d "$BINDIR" ] && [ -n "$OLDEST" ]; then
  NEWEST_BIN=$(ls -1 "$BINDIR" | grep -E '^mysql-bin\.[0-9]{6}$' | sort | tail -n 1)
  find "$BINDIR" -maxdepth 1 -name 'mysql-bin.[0-9]*' -mtime +7 ! -newer "$OLDEST" ! -name "$NEWEST_BIN" | sort | while read -r f; do
    rm -f "$f" && log "DEL  binlog: $(basename "$f") (7일 경과 · 가장 오래된 전체 백업 이전)"
  done
fi

# 3) 지표
mkdir -p "$METRICS_DIR"
PROM=$METRICS_DIR/backup_rotate.prom
prev=$(grep '^backup_rotate_last_success_timestamp_seconds ' "$PROM" 2>/dev/null)
{
  echo "# HELP backup_archive_files Number of files per GFS tier"
  echo "# TYPE backup_archive_files gauge"
  for tier in $TIERS; do for t in $TARGETS; do
    n=$(find "$ARCHIVE/$tier/$t" -maxdepth 1 -type f ! -name '*.tmp' 2>/dev/null | wc -l)
    echo "backup_archive_files{tier=\"$tier\",target=\"$t\"} $n"
  done; done
  echo "# TYPE backup_rotate_last_success_timestamp_seconds gauge"
  if [ $FAIL -eq 0 ]; then echo "backup_rotate_last_success_timestamp_seconds $(date +%s)"
  elif [ -n "$prev" ]; then echo "$prev"; fi
} > "$PROM.$$" && chmod 644 "$PROM.$$" && mv -f "$PROM.$$" "$PROM"

[ $FAIL -eq 0 ] && log "완료" || log "완료 (실패 있음)"
exit $FAIL
```

### A-2. backup .41 — /usr/local/bin/mysql_binlog_stream.sh

```bash
#!/bin/bash
# mysql-source의 binlog를 /backup/binlog에 실시간 저장 (systemd: mysql-binlog-stream)
set -uo pipefail
DIR=/backup/binlog
CNF=/root/.binlog.cnf
cd "$DIR" || exit 1

# 이어받을 파일: 받은 게 있으면 가장 최신부터(덮어쓰며 다시), 없으면 Source의 가장 오래된 것부터
LAST=$(ls -1 "$DIR" | grep -E '^mysql-bin\.[0-9]{6}$' | sort | tail -n 1)
if [ -n "$LAST" ]; then
  START=$LAST
else
  START=$(mysql --defaults-extra-file=$CNF -N -e "SHOW BINARY LOGS" | awk 'NR==1{print $1}')
fi
[ -n "$START" ] || { echo "시작 파일을 정하지 못함 (Source 접속 확인)"; exit 1; }
echo "시작 파일: $START"

exec mysqlbinlog --defaults-extra-file=$CNF --read-from-remote-server --raw --stop-never \
  --connection-server-id=4101 --result-file="$DIR/" "$START"
```

### A-3. backup .41 — /etc/systemd/system/mysql-binlog-stream.service

```ini
[Unit]
Description=MySQL binlog stream from mysql-source (playlog PITR)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/mysql_binlog_stream.sh
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

### A-4. backup .41 — /usr/local/bin/binlog_metrics.sh (5분마다)

```bash
#!/bin/bash
# binlog 전송 상태 지표 (cron 5분)
DIR=/backup/binlog
P=/var/lib/node_exporter/textfile/backup_binlog.prom
UP=0
if systemctl is-active --quiet mysql-binlog-stream && \
   ss -Htnp state established dst 192.168.56.21:3306 | grep -q mysqlbinlog; then UP=1; fi
LAST=$(ls -1t $DIR/mysql-bin.[0-9]* 2>/dev/null | head -n 1)
TS=0; [ -n "$LAST" ] && TS=$(stat -c %Y "$LAST")
FILES=$(ls -1 $DIR/mysql-bin.[0-9]* 2>/dev/null | wc -l)
BYTES=$(du -sb $DIR 2>/dev/null | cut -f1)
{
  echo "# HELP backup_binlog_stream_up 1 if mysql-binlog-stream is connected to mysql-source"
  echo "# TYPE backup_binlog_stream_up gauge"
  echo "backup_binlog_stream_up $UP"
  echo "# TYPE backup_binlog_last_write_timestamp_seconds gauge"
  echo "backup_binlog_last_write_timestamp_seconds $TS"
  echo "# TYPE backup_binlog_files gauge"
  echo "backup_binlog_files $FILES"
  echo "# TYPE backup_binlog_bytes gauge"
  echo "backup_binlog_bytes ${BYTES:-0}"
} > $P.$$ && chmod 644 $P.$$ && mv -f $P.$$ $P
```

### A-5. backup .41 — /usr/local/bin/restore_test.sh v2 (매월 1일 05:30)

```bash
#!/bin/bash
# 최신 백업을 restore_test에 복원 + binlog 적용(PITR)해 확인 -> 성공 시각 기록
# v2 (2026-11-11): 복원 작업은 binlog에 남기지 않음(sql_log_bin=0), PITR 검사 추가
set -euo pipefail
PROM=/var/lib/node_exporter/textfile
LOG=/backup/restore_test.log
MY=/root/.my-restore.cnf
REPL=/root/.backup.cnf
MURI="mongodb://restore@192.168.56.22:27017,192.168.56.24:27017,192.168.56.25:27017/?replicaSet=rs0&authSource=admin"
MPW=$(awk '/^password:/{print $2}' /root/.mongo-restore.yaml)
M=$(ls -t /backup/mysql/steam_*.sql.gz | head -1)
G=$(ls -t /backup/mongo/rs0_*.archive.gz | head -1)
NOLOG="SET sql_log_bin=0;"
trap 'echo "$(date "+%F %T") FAIL (line $LINENO)" >> $LOG' ERR

# MySQL ① 전체 백업 -> restore_test (binlog에 남기지 않음: Replica로 복제 안 됨, 다음 PITR에도 안 섞임)
mysql --defaults-extra-file=$MY -e "$NOLOG DROP DATABASE IF EXISTS restore_test"
( echo "$NOLOG"; zcat "$M" | sed -e 's/DEFINER=`[^`]*`@`[^`]*`//g' -e 's/`steam`/`restore_test`/g' ) \
  | mysql --defaults-extra-file=$MY
TABLES=$(mysql --defaults-extra-file=$MY -N -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='restore_test' AND table_type='BASE TABLE'")
REVIEWS=$(mysql --defaults-extra-file=$MY -N -e "SELECT COUNT(*) FROM restore_test.REVIEW")
[ "$TABLES" -ge 14 ]

# MySQL ② PITR: 덤프 이후 binlog를 전부 적용 -> 운영(Replica)과 건수 비교
DUMP_GTID=$(zcat "$M" | head -40 | tr -d '\n' | grep -oP "GTID_PURGED='\+?\K[^']+" || true)
[ -n "$DUMP_GTID" ]
mysqlbinlog --skip-gtids --disable-log-bin --exclude-gtids="$DUMP_GTID" \
  --rewrite-db='steam->restore_test' --database=restore_test /backup/binlog/mysql-bin.[0-9]* \
  | mysql --defaults-extra-file=$MY
P_MEM=$(mysql --defaults-extra-file=$MY   -N -e "SELECT COUNT(*) FROM restore_test.MEMBER")
P_REV=$(mysql --defaults-extra-file=$MY   -N -e "SELECT COUNT(*) FROM restore_test.REVIEW")
O_MEM=$(mysql --defaults-extra-file=$REPL -N -e "SELECT COUNT(*) FROM steam.MEMBER")
O_REV=$(mysql --defaults-extra-file=$REPL -N -e "SELECT COUNT(*) FROM steam.REVIEW")
mysql --defaults-extra-file=$MY -e "$NOLOG DROP DATABASE restore_test"
[ "$P_MEM" = "$O_MEM" ]
[ "$P_REV" = "$O_REV" ]

# MongoDB: playlog.* -> restore_test.*
mongorestore --config=/root/.mongo-restore.yaml --uri="$MURI" --gzip --archive="$G" \
  --nsInclude='playlog.*' --nsFrom='playlog.*' --nsTo='restore_test.*' --drop --quiet
DOCS=$(mongosh "$MURI" -p "$MPW" --quiet --eval '
  const d = db.getSiblingDB("restore_test");
  print(d.getCollectionNames().reduce((s, c) => s + d[c].countDocuments(), 0))')
mongosh "$MURI" -p "$MPW" --quiet --eval 'db.getSiblingDB("restore_test").dropDatabase()' >/dev/null
[ "$DOCS" -ge 1 ]

echo "$(date '+%F %T') OK   mysql=$(basename "$M") tables=$TABLES reviews=$REVIEWS pitr=member:$P_MEM/$O_MEM,review:$P_REV/$O_REV | mongo=$(basename "$G") docs=$DOCS" >> $LOG
printf 'restore_test_last_success_timestamp_seconds %s\n' "$(date +%s)" > $PROM/restore_test.prom.tmp
mv $PROM/restore_test.prom.tmp $PROM/restore_test.prom
```

### A-6. mongo-3 .25 — /usr/local/bin/cold_backup.sh (매월 1일 05:00)

```bash
#!/bin/bash
# mongo-3 오프라인(cold) 백업 (매월 1일 05:00)
# SECONDARY이고 3대 모두 정상일 때만 mongod를 잠깐 멈추고 데이터 폴더를 통째로 묶는다
set -uo pipefail
DIR=/var/backup/cold
OUT=$DIR/mongo_$(date +%Y%m).tar.gz
LOG=$DIR/cold.log
AM=http://192.168.56.42:9093
MATCH='(mongo-3|192.168.56.25)(:.*)?'
mkdir -p $DIR; chmod 700 $DIR
log(){ echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
state(){ mongosh "mongodb://${1:-127.0.0.1:27017}/?directConnection=true" --quiet --eval \
  'const h=db.hello(); print(h.isWritablePrimary ? "P" : (h.secondary ? "S" : "X"))' 2>/dev/null; }

# 1) 조건 확인: 나는 SECONDARY, 멤버 3대 모두 PRIMARY/SECONDARY (1대 멈춰도 과반 유지)
[ "$(state)" = S ] || { log "FAIL SECONDARY 아님 → 중단"; exit 1; }
OK=0
for h in $(mongosh --quiet --eval 'print(db.hello().hosts.join(" "))'); do
  case $(state "$h") in P|S) OK=$((OK+1));; esac
done
[ $OK -ge 3 ] || { log "FAIL 정상 멤버 $OK대 (<3) → 중단"; exit 1; }

# 2) 알림 묵음 15분 (실패해도 백업은 진행)
BODY=$(printf '{"matchers":[{"name":"instance","value":"%s","isRegex":true,"isEqual":true}],"startsAt":"%s","endsAt":"%s","createdBy":"cold_backup.sh","comment":"monthly cold backup (mongo-3)"}' \
  "$MATCH" "$(date -u +%FT%TZ)" "$(date -u -d '+15 min' +%FT%TZ)")
SID=$(curl -s -m 5 -X POST -H 'Content-Type: application/json' -d "$BODY" $AM/api/v2/silences | grep -oP '"silenceID":"\K[^"]+')
[ -n "$SID" ] && log "알림 묵음 15분: $SID" || log "WARN 알림 묵음 실패 (계속 진행)"

# 3) 정지 → 묶기 → 시작 (무슨 일이 있어도 다시 시작)
trap 'systemctl start mongod' EXIT
T0=$(date +%s)
systemctl stop mongod || { log "FAIL mongod 정지 실패"; exit 1; }
tar --selinux --acls --xattrs -czf "$OUT.tmp" -C /var/lib mongo; RC=$?
systemctl start mongod; T1=$(date +%s)
trap - EXIT

# 4) SECONDARY 복귀 확인 (최대 2분)
for i in $(seq 1 60); do [ "$(state)" = S ] && break; sleep 2; done
ST=$(state)

if [ $RC -eq 0 ] && gzip -t "$OUT.tmp"; then
  mv -f "$OUT.tmp" "$OUT"; chmod 600 "$OUT"; ln -sfn "$(basename "$OUT")" $DIR/latest.tar.gz
  ls -1t $DIR/mongo_*.tar.gz | tail -n +3 | xargs -r rm -f      # 로컬은 최근 2개만 (.41에 12개 보관)
  log "OK   $(basename "$OUT") $(du -h "$OUT" | cut -f1), 정지 $((T1-T0))초, 복귀 상태=$ST"
else
  rm -f "$OUT.tmp"; log "FAIL tar (rc=$RC), 복귀 상태=$ST"; exit 1
fi
[ "$ST" = S ] || { log "FAIL 2분 안에 SECONDARY로 복귀하지 않음"; exit 1; }
```

### A-7. mysql-replica .23 — /usr/local/bin/cold_backup.sh (매월 1일 05:00)

```bash
#!/bin/bash
# mysql-replica 오프라인(cold) 백업 (매월 1일 05:00)
# 복제가 정상일 때만 mysqld를 잠깐 멈추고 데이터 폴더를 통째로 묶는다 (Source는 멈추지 않음)
set -uo pipefail
DIR=/var/backup/cold
OUT=$DIR/mysql_$(date +%Y%m).tar.gz
LOG=$DIR/cold.log
AM=http://192.168.56.42:9093
MATCH='(mysql-replica|192.168.56.23)(:.*)?'
CNF=/etc/.mysqld_exporter.cnf          # exporter@localhost (REPLICATION CLIENT) — Replica에서 계정을 새로 만들지 않기 위해 재사용
mkdir -p $DIR; chmod 700 $DIR
log(){ echo "$(date '+%F %T') $*" | tee -a "$LOG"; }
repl(){ mysql --defaults-extra-file=$CNF -e "SHOW REPLICA STATUS\G" 2>/dev/null \
  | awk -F': ' '/Replica_IO_Running:/{io=$2} /Replica_SQL_Running:/{sq=$2} /Seconds_Behind_Source:/{lag=$2} END{print io, sq, lag}'; }

# 1) 조건 확인: 복제 IO/SQL Yes, 지연 60초 이하
read IO SQ LAG <<< "$(repl)"
[ "$IO" = Yes ] && [ "$SQ" = Yes ] && [ "${LAG:-999}" != NULL ] && [ "${LAG:-999}" -le 60 ] \
  || { log "FAIL 복제 상태 이상 (IO=$IO SQL=$SQ lag=$LAG) → 중단"; exit 1; }

# 2) 알림 묵음 15분 (실패해도 백업은 진행)
BODY=$(printf '{"matchers":[{"name":"instance","value":"%s","isRegex":true,"isEqual":true}],"startsAt":"%s","endsAt":"%s","createdBy":"cold_backup.sh","comment":"monthly cold backup (mysql-replica)"}' \
  "$MATCH" "$(date -u +%FT%TZ)" "$(date -u -d '+15 min' +%FT%TZ)")
SID=$(curl -s -m 5 -X POST -H 'Content-Type: application/json' -d "$BODY" $AM/api/v2/silences | grep -oP '"silenceID":"\K[^"]+')
[ -n "$SID" ] && log "알림 묵음 15분: $SID" || log "WARN 알림 묵음 실패 (계속 진행)"

# 3) 정지 → 묶기 → 시작 (무슨 일이 있어도 다시 시작)
trap 'systemctl start mysqld' EXIT
T0=$(date +%s)
systemctl stop mysqld || { log "FAIL mysqld 정지 실패"; exit 1; }
tar --selinux --acls --xattrs -czf "$OUT.tmp" -C /var/lib mysql; RC=$?
systemctl start mysqld; T1=$(date +%s)
trap - EXIT

# 4) 복제 재개 확인 (최대 2분)
for i in $(seq 1 60); do read IO SQ LAG <<< "$(repl)"; [ "$IO" = Yes ] && [ "$SQ" = Yes ] && break; sleep 2; done

if [ $RC -eq 0 ] && gzip -t "$OUT.tmp"; then
  mv -f "$OUT.tmp" "$OUT"; chmod 600 "$OUT"; ln -sfn "$(basename "$OUT")" $DIR/latest.tar.gz
  ls -1t $DIR/mysql_*.tar.gz | tail -n +3 | xargs -r rm -f      # 로컬은 최근 2개만 (.41에 12개 보관)
  log "OK   $(basename "$OUT") $(du -h "$OUT" | cut -f1), 정지 $((T1-T0))초, 복제 IO=$IO SQL=$SQ lag=$LAG"
else
  rm -f "$OUT.tmp"; log "FAIL tar (rc=$RC), 복제 IO=$IO SQL=$SQ"; exit 1
fi
[ "$IO" = Yes ] && [ "$SQ" = Yes ] || { log "FAIL 2분 안에 복제가 재개되지 않음"; exit 1; }
```

### A-8. mongo-3 · mysql-replica — /usr/local/bin/cold_send.sh (전용 키 강제 명령)

```bash
#!/bin/bash
# .41 전용 키의 강제 명령: 24시간 안에 만든 cold 백업만 내보냄 (오래된 파일을 "성공"으로 가져가지 않게)
F=/var/backup/cold/latest.tar.gz
[ -n "$(find -L "$F" -mmin -1440 2>/dev/null)" ] || { echo "latest.tar.gz 없음 또는 24시간 경과" >&2; exit 1; }
exec cat "$F"
```

### A-9. backup .41 — /usr/local/bin/cold_pull.sh (매월 1일 05:20)

```bash
#!/bin/bash
# 매월 1일 05:20: mongo-3 · mysql-replica의 cold 백업을 가져옴 (전용 키, 강제 명령) -> /backup/cold (12개)
set -uo pipefail
PROM=/var/lib/node_exporter/textfile
LOG=/backup/cold/pull.log
KEY=/root/.ssh/cold_pull
FAIL=0
mkdir -p /backup/cold/{mongo,mysql}; chmod 700 /backup/cold
for pair in mongo:192.168.56.25 mysql:192.168.56.23; do
  t=${pair%%:*}; h=${pair#*:}
  OUT=/backup/cold/$t/${t}_$(date +%Y%m).tar.gz
  if ssh -T -i $KEY -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 root@$h > "$OUT.tmp" 2>>"$LOG" \
     && gzip -t "$OUT.tmp"; then
    mv -f "$OUT.tmp" "$OUT"; chmod 600 "$OUT"
    ls -1t /backup/cold/$t/${t}_*.tar.gz | tail -n +13 | xargs -r rm -f
    echo "$(date '+%F %T') OK   $t $(basename "$OUT") $(du -h "$OUT" | cut -f1)" >> "$LOG"
    printf 'backup_cold_last_success_timestamp_seconds{target="%s"} %s\nbackup_cold_size_bytes{target="%s"} %s\n' \
      "$t" "$(date +%s)" "$t" "$(stat -c %s "$OUT")" > $PROM/backup_cold_$t.prom.tmp && mv -f $PROM/backup_cold_$t.prom.tmp $PROM/backup_cold_$t.prom
  else
    rm -f "$OUT.tmp"; echo "$(date '+%F %T') FAIL $t ($h)" >> "$LOG"; FAIL=1
  fi
done
exit $FAIL
```

### A-10. cron · 키 등록

```bash
# backup .41
echo '0 5 * * * root /usr/local/bin/backup_rotate.sh > /dev/null 2>&1'     > /etc/cron.d/backup_rotate
echo '*/5 * * * * root /usr/local/bin/binlog_metrics.sh > /dev/null 2>&1'  > /etc/cron.d/binlog_metrics
echo '20 5 1 * * root /usr/local/bin/cold_pull.sh > /dev/null 2>&1'        > /etc/cron.d/cold_pull
echo '30 5 1 * * root /usr/local/bin/restore_test.sh'                      > /etc/cron.d/restore_test   # 기존
ssh-keygen -t ed25519 -N '' -C 'backup-cold-pull' -f /root/.ssh/cold_pull -q

# mongo-3 · mysql-replica
echo '0 5 1 * * root /usr/local/bin/cold_backup.sh > /dev/null 2>&1' > /etc/cron.d/cold_backup
# /root/.ssh/authorized_keys 에 한 줄:
#   from="192.168.56.41",restrict,command="/usr/local/bin/cold_send.sh" ssh-ed25519 AAAA… backup-cold-pull
restorecon -v /root/.ssh/authorized_keys
```

### A-11. 알림 규칙 (monitor .42 `alert_rules_steam.yml` backup 묶음에 추가)

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
