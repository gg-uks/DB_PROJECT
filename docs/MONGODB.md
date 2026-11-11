# MongoDB Replica Set 구성 기록 (Rocky Linux 10.2 · MongoDB 8.0.34)

> 작업일: 2026-11-10 · **2026-11-10 변경: Arbiter 대신 데이터 노드 mongo-3(.25) 추가 → 3대 모두 데이터를 가진 구성(PSS)**
> **실제 환경: Rocky Linux 10.2 · 내부망 192.168.56.x** (서버 주소는 프로젝트의 `내부 서버 IP주소` 문서가 기준). 백업 · 복구 · 모니터링은 `backup_monitoring_rocky.md`.
> Ubuntu와 다른 점: `dnf` 설치 · `firewalld` · 서비스 사용자 `mongod` · dbPath `/var/lib/mongo` · SELinux
> **앱 DB 이름은 `playlog`** (컬렉션 `game_raw` 30 · `review_text` 7,493, 2026-11-10 확인). 발표 자료의 `steam`은 MySQL DB 이름.
> 7.0 공식 저장소는 RHEL 9까지만 있어 **8.0** 사용. 세 서버 모두 같은 버전으로 맞출 것.

| 서버 | IP | 역할 | 상태 |
|---|---|---|---|
| mongo-1 | 192.168.56.22 | Primary (priority 2) | ✅ 1~10장 완료 |
| mongo-2 | 192.168.56.24 | Secondary (priority 1) | ✅ 1~10장 완료 |
| mongo-3 | 192.168.56.25 | Secondary (priority 1) | ✅ 11장 완료 (2026-11-10, v8.0.34) — 복제 확인 · 자동 승격(.22 정지 → .24 PRIMARY → .22 복귀 시 다시 PRIMARY) 확인 |

**왜 Arbiter가 아니라 데이터 노드 3대인가**

| | P + S + Arbiter (이전 계획) | P + S + S (변경) |
|---|---|---|
| 데이터 사본 | 2개 | **3개** |
| Primary 장애 | 자동 승격 (3표 중 2표) | 자동 승격 (3표 중 2표) |
| Secondary 1대 장애 | `w: majority` 쓰기 멈춤 → 기본값을 `w: 1`로 낮춰야 함 | **정상** (2대가 과반) |
| 비용 | VM 추가 없음 | VM 1대 (1.5GB, 합계 RAM 21GB / 32GB) |

MongoDB가 권장하는 기본 구성이 P+S+S이고, "3대가 엮인 클러스터" 요건에도 데이터 기준으로 맞는다.

---

## 1. MongoDB 설치

```bash
cat > /etc/yum.repos.d/mongodb-org-8.0.repo <<'EOF'
[mongodb-org-8.0]
name=MongoDB Repository
baseurl=https://repo.mongodb.org/yum/redhat/10/mongodb-org/8.0/x86_64/
gpgcheck=1
enabled=1
gpgkey=https://pgp.mongodb.com/server-8.0.asc
EOF
dnf install -y mongodb-org
mongod --version
```

> `dnf`에서 404가 나오면 baseurl의 `10`을 `9`로 바꿔 다시 시도.

## 2. 공통 설정

```bash
timedatectl set-timezone Asia/Seoul
cat >> /etc/hosts <<'EOF'
192.168.56.22 mongo-1
192.168.56.24 mongo-2
192.168.56.25 mongo-3
EOF
```

> mongo-1 · mongo-2는 이미 2줄이 있으므로 `192.168.56.25 mongo-3` 한 줄만 추가.

## 3. keyFile 생성 · 복사 (멤버 간 인증)

```bash
# mongo-1
openssl rand -base64 756 > /etc/mongo-keyfile
chmod 400 /etc/mongo-keyfile
chown mongod:mongod /etc/mongo-keyfile
scp /etc/mongo-keyfile root@192.168.56.24:/etc/mongo-keyfile

# mongo-2
chmod 400 /etc/mongo-keyfile
chown mongod:mongod /etc/mongo-keyfile
restorecon -v /etc/mongo-keyfile     # scp로 받은 파일의 SELinux 라벨 정리
```

## 4. `/etc/mongod.conf` 수정

```yaml
storage:
  dbPath: /var/lib/mongo
net:
  port: 27017
  bindIp: 127.0.0.1,192.168.56.22     # mongo-2는 .24, mongo-3은 .25
security:
  keyFile: /etc/mongo-keyfile
replication:
  replSetName: rs0
```

> YAML 들여쓰기는 공백 2칸 (탭 금지).

## 5. 방화벽 firewalld

```bash
# 27017: Mongo 멤버(.22 .24 .25) · WEB(.11 .12) · Backup(.41, mongodump/복구)
for ip in 22 24 25 11 12 41; do
  firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=192.168.56.$ip port port=27017 protocol=tcp accept"
done
# 9216: mongodb_exporter → Monitor(.42)만
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=192.168.56.42 port port=9216 protocol=tcp accept"
firewall-cmd --reload
firewall-cmd --list-rich-rules
```

> 이미 구성한 mongo-1 · mongo-2는 `.25` 규칙 하나만 추가하면 된다 (11-1).

## 6. mongod 시작 · 연결 확인

```bash
systemctl enable --now mongod
systemctl restart mongod
systemctl status mongod

# mongo-1 → mongo-2
timeout 3 bash -c '</dev/tcp/192.168.56.24/27017' && echo OK
# mongo-2 → mongo-1
timeout 3 bash -c '</dev/tcp/192.168.56.22/27017' && echo OK
```

## 7. Replica Set 초기화 (mongo-1, `mongosh`로 localhost 접속)

```js
rs.initiate({
  _id: "rs0",
  members: [
    { _id: 0, host: "192.168.56.22:27017", priority: 2 },
    { _id: 1, host: "192.168.56.24:27017", priority: 1 }
  ]
})
```

→ `{ ok: 1 }`, 프롬프트가 `rs0 [direct: primary]`로 바뀜. mongo-3은 11장에서 `rs.add`로 추가.

## 8. 관리자 계정 생성 (mongo-1, localhost 접속 상태에서 한 줄씩)

```js
use admin
```
```js
db.createUser({ user: "admin", pwd: "<ADMIN_PASSWORD>", roles: [{ role: "root", db: "admin" }] })
```

> **주의**
> - 여러 줄을 한 번에 붙여넣으면 `use admin`만 실행되고 `createUser`가 안 될 수 있음 → 한 줄씩 입력하고 `{ ok: 1 }` 확인.
> - 인증 없이 접속한 상태에서는 계정이 없어도 `db.getUsers()`가 `Unauthorized`로 나옴 (localhost 예외는 첫 계정 생성만 허용). 계정 생성 여부는 `createUser`의 `{ ok: 1 }`로 판단.
> - `mongosh "mongodb://..."`는 bash 명령. mongosh 안에서 치면 SyntaxError.

## 9. 인증 접속 · 상태 확인

```bash
mongosh "mongodb://admin:<ADMIN_PASSWORD>@192.168.56.22,192.168.56.24,192.168.56.25/admin?replicaSet=rs0"
```
```js
rs.status().members.map(m => [m.name, m.stateStr])
```

> 접속 시 나오는 memory allocator · swappiness 경고는 성능 권고 (실습 환경에서는 무시 가능).

## 10. 복제 테스트 · 정리

→ **11-4 방식을 쓸 것** (테스트 전용 DB `repl_check`에 넣고 → Secondary에서 조회 → `dropDatabase()`). 운영 DB(`playlog`)에 테스트 컬렉션을 만들고 `drop()`하면 같은 이름의 실제 컬렉션을 지울 위험이 있다.

---

## 11. mongo-3 (.25) 추가

### 11-0. VM 생성 (빈 Rocky 템플릿 복제)

| 항목 | 값 |
|---|---|
| 호스트명 | mongo-3 |
| 사양 | 2 vCPU · 1.5GB · 디스크 20GB 이상 |
| 어댑터 1 | NAT (enp0s3) — 주소만 받고 기본 경로로는 안 씀 |
| 어댑터 2 | 호스트 전용 `VirtualBox Host-Only Ethernet Adapter` (enp0s8) — **192.168.56.25/24, 게이트웨이 192.168.56.2(NAT GW)** |

> mongod가 설치된 mongo-1 · mongo-2 VM은 **복제하지 말 것** (`/var/lib/mongo` 데이터 · 멤버 정보까지 복사됨). 아무것도 설치하지 않은 Rocky 템플릿 복제는 OK.

1. VirtualBox 복제: 이름 `mongo-3`, **MAC 주소 정책 "모든 네트워크 어댑터의 새 MAC 주소 생성"**, 완전한 복제
2. 부팅 전 설정: 시스템 → 메모리 1536MB · CPU 2 / 네트워크 → mongo-2와 동일 (어댑터 1 NAT, 어댑터 2 호스트 전용)
3. mongo-2에서 복사할 값 확인:
   ```bash
   nmcli -g ipv4.dns con show enp0s8                                                  # DNS
   nmcli -g ipv4.never-default,ipv4.ignore-auto-dns con show enp0s3                  # NAT 어댑터 설정
   ```
4. mongo-3 부팅 → 콘솔에서 root 로그인 → 복제 흔적 정리:
   ```bash
   rm -f /etc/machine-id && systemd-machine-id-setup
   rm -f /etc/ssh/ssh_host_* && ssh-keygen -A && systemctl restart sshd
   ```
5. 네트워크 · 호스트 이름 (연결 이름은 `nmcli -t -f NAME,DEVICE con show`로 확인):
   ```bash
   nmcli con mod enp0s8 ipv4.method manual ipv4.addresses 192.168.56.25/24 \
     ipv4.gateway 192.168.56.2 ipv4.dns "<mongo-2와 같은 DNS>" connection.autoconnect yes
   nmcli con mod enp0s3 ipv4.never-default yes          # 3번 결과에 맞춤 (ignore-auto-dns가 yes면 그것도)
   nmcli con up enp0s8; nmcli con up enp0s3
   hostnamectl set-hostname mongo-3
   timedatectl set-timezone Asia/Seoul
   reboot
   ```
6. 확인:
   ```bash
   ip -4 a                                        # enp0s3 10.0.2.15, enp0s8 192.168.56.25
   ip route | grep default                        # default via 192.168.56.2 dev enp0s8 — 한 줄만
   ping -c 2 192.168.56.22 && ping -c 2 192.168.56.24
   curl -sI https://repo.mongodb.org | head -1    # NAT GW 경유 외부 통신
   ```

### 11-1. 기존 두 서버(.22 · .24)에 .25 허용

```bash
# mongo-1, mongo-2 각각
echo "192.168.56.25 mongo-3" >> /etc/hosts
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=192.168.56.25 port port=27017 protocol=tcp accept"
firewall-cmd --permanent --add-rich-rule="rule family=ipv4 source address=192.168.56.41 port port=27017 protocol=tcp accept"   # 이미 있으면 ALREADY_ENABLED 경고, 무시
firewall-cmd --reload
```

### 11-2. mongo-3 설치 · 설정

1장(설치) → 2장(hosts 3줄) → 4장(`bindIp: 127.0.0.1,192.168.56.25`) → 5장(방화벽) 순서로 진행.

keyFile은 mongo-1에서 복사:

```bash
# mongo-1에서
scp /etc/mongo-keyfile root@192.168.56.25:/etc/mongo-keyfile

# mongo-3에서
chmod 400 /etc/mongo-keyfile
chown mongod:mongod /etc/mongo-keyfile
restorecon -v /etc/mongo-keyfile

systemctl enable --now mongod
systemctl status mongod

# 연결 확인 (mongo-3 → 1, 2 / mongo-1 → 3)
timeout 3 bash -c '</dev/tcp/192.168.56.22/27017' && echo OK
timeout 3 bash -c '</dev/tcp/192.168.56.24/27017' && echo OK
```

> mongo-3에서는 `rs.initiate()`나 계정 생성을 **하지 않는다.** 멤버로 추가되면 Primary의 데이터와 계정이 자동으로 복사된다.

### 11-3. Replica Set에 추가 (mongo-1, Primary에서)

```bash
mongosh "mongodb://admin:<ADMIN_PASSWORD>@192.168.56.22,192.168.56.24/admin?replicaSet=rs0"
```
```js
rs.add({ host: "192.168.56.25:27017", priority: 1 })
```
```js
rs.status().members.map(m => [m.name, m.stateStr])
// 처음엔 STARTUP2(초기 동기화) → 잠시 후 SECONDARY
// [ '…22:27017','PRIMARY' ], [ '…24:27017','SECONDARY' ], [ '…25:27017','SECONDARY' ]
```
```js
rs.conf().members.map(m => [m.host, m.priority, m.votes])   // 3대 모두 votes 1
```

> Arbiter용으로 `setDefaultRWConcern { w: 1 }`을 실행했다면 기본값으로 되돌린다:
> `db.adminCommand({ setDefaultRWConcern: 1, defaultWriteConcern: { w: "majority" } })`

### 11-4. 복제 확인

운영 DB(`playlog`)를 건드리지 않도록 테스트 전용 DB `repl_check`를 쓴다. mongosh에서 `use`가 섞인 여러 줄을 붙여넣으면 SyntaxError가 나므로 **한 줄씩**, `db.getSiblingDB()` 형태로 실행. **순서 주의: ② 조회 전에 ③ 삭제를 하면 삭제까지 복제돼서 빈 결과가 나온다.**

```js
// ① mongo-1 (PRIMARY)
db.getSiblingDB("repl_check").ping.insertOne({ msg: "to mongo-3" })
```
```bash
# ② mongo-3 — bash에서 먼저 mongosh 접속
mongosh -u admin -p --authenticationDatabase admin
```
```js
db.getMongo().setReadPref("secondaryPreferred"); db.getSiblingDB("repl_check").ping.find()
// [ { _id: ObjectId('…'), msg: 'to mongo-3' } ] 가 보이면 성공
```
```js
// ③ mongo-1에서 정리
db.getSiblingDB("repl_check").dropDatabase()
```

기존 데이터 동기화 확인 (mongo-3, 결과가 mongo-1과 같아야 함 — 아무것도 안 나오면 아직 데이터 적재 전):
```js
db.getSiblingDB("playlog").getCollectionNames().forEach(c => print(c, db.getSiblingDB("playlog")[c].countDocuments()))
```

### 11-5. 자동 승격 테스트

```bash
# mongo-1
systemctl stop mongod
# 10~15초 뒤 mongo-2나 mongo-3에서 rs.status() → 둘 중 하나가 PRIMARY
systemctl start mongod
# priority 2라 잠시 후 mongo-1이 다시 PRIMARY
```

> 상태 확인은 mongo-2나 mongo-3의 mongosh에서 (mongo-1은 꺼지는 서버). mongo-1에 열어 둔 mongosh는 끊긴다.

추가로 **Secondary 1대를 꺼도** (예: mongo-3 `systemctl stop mongod`) Primary에서 아래가 바로 `acknowledged: true`인지 확인 → 3대 구성의 장점 (Arbiter 구성이면 여기서 멈춤):
```js
db.getSiblingDB("repl_check").ping.insertOne({ x: 1 }, { writeConcern: { w: "majority", wtimeout: 5000 } })
```
확인 후 mongo-3 `systemctl start mongod`, Primary에서 `db.getSiblingDB("repl_check").dropDatabase()`.

### 11-6. 앱 연결 문자열 변경 (WEB 담당에게 전달)

```
mongodb://<user>:<pw>@192.168.56.22,192.168.56.24,192.168.56.25/playlog?replicaSet=rs0&authSource=admin
```

> **실제 적용 (WEB1 · WEB2 `.env`)**: 앱은 관리자 계정이 아니라 `playlog` DB에 만든 앱 전용 계정(`readWrite`)을 쓴다 → `authSource=playlog`
> `MONGODB_URI=mongodb://playlog:<비밀번호_URL인코딩>@192.168.56.22:27017,192.168.56.24:27017,192.168.56.25:27017/?replicaSet=rs0&authSource=playlog`
> 비밀번호의 `#`은 `%23`으로 바꿔 쓴다.

> `replicaSet=rs0`이 있으면 드라이버가 멤버를 자동으로 찾으므로 .25를 빠뜨려도 동작은 하지만, 처음 접속하는 서버가 꺼져 있을 때를 대비해 3개 모두 적는다.

---

## 남은 작업

1. ~~mongo-3 추가 (11장)~~ ✅ 2026-11-10
   - 앱 연결 문자열에 .25 추가 (11-6) → WEB 담당 전달
2. admin 비밀번호 변경: `db.changeUserPassword("admin", "새비밀번호")`
3. 백업 · exporter용 계정, mongodb_exporter(9216), 백업 스크립트 → `backup_monitoring_rocky.md`
4. 발표 자료 반영: 25 · 26 · 30장 (Arbiter → mongo-3, VM 13대, RAM 21GB)

## 트러블슈팅 (Rocky)

| 증상 | 확인 |
|---|---|
| mongod가 안 뜸 | `journalctl -u mongod -n 50`, `tail /var/log/mongodb/mongod.log` |
| keyFile `Permission denied` | `ls -lZ /etc/mongo-keyfile` (mongod 소유 · 400), `ausearch -m avc -ts recent` (SELinux) |
| 상대 서버 연결 실패 | `firewall-cmd --list-rich-rules`, `ss -lntp \| grep 27017`에 자기 IP가 있는지 |
| mongo-3이 계속 STARTUP2 · RECOVERING | 초기 동기화 중 (데이터가 적으면 수 초) — `tail -f /var/log/mongodb/mongod.log`에서 오류 확인, 디스크 여유 확인 |
| `rs.add` 후 mongo-3이 `(not reachable/healthy)` | .22 · .24 → .25 방화벽(5장), .25 → .22 · .24 방화벽(11-1), keyFile 내용 일치 여부 |
| 앱 연결 안 됨 | 연결 문자열에 `?replicaSet=rs0` 누락 |
