# infra/ — 서버 설정 파일

설명은 [`docs/INFRA.md`](../docs/INFRA.md). 이 폴더의 파일을 각 서버의 아래 위치에 복사해서 쓴다. 비밀번호는 `<…>` 자리에 서버에서 직접 넣는다.

| 파일 | 서버 | 서버 위치 |
|---|---|---|
| `haproxy/haproxy.cfg` | .10 | `/etc/haproxy/haproxy.cfg` |
| `nginx/playlog.conf` | .11 · .12 | `/etc/nginx/conf.d/playlog.conf` |
| `pm2/ecosystem.config.cjs` | .11 · .12 | 저장소 그대로 (`pm2 start infra/pm2/ecosystem.config.cjs`) |
| `pm2/env.vm.example` | .11 · .12 | `/opt/playlog/backend/.env` 로 복사 후 값 채우기 |
| `valkey/valkey.conf.diff` | .31 | `/etc/valkey/valkey.conf` 에 반영 |
| `kafka/server.properties.diff` | .31 | `/opt/kafka/config/server.properties` 에 반영 |
| `kafka/kafka.service` | .31 | `/etc/systemd/system/kafka.service` |
| `kafka/topic.sh` | .31 | 토픽 생성 · 확인 |
| `elasticsearch/elasticsearch.yml` | .33 | `/etc/elasticsearch/elasticsearch.yml` |
| `elasticsearch/heap.options` | .33 | `/etc/elasticsearch/jvm.options.d/heap.options` |
| `mysql/source.cnf` · `replica.cnf` | .21 · .23 | `/etc/my.cnf.d/mysql-server.cnf` 의 `[mysqld]` |
| `mysql/replication.sql` | .21 · .23 | 복제 설정 순서 |
| `mongodb/mongod.conf.25` | .25 | `/etc/mongod.conf` (복제 세트 부분) |
| `mongodb/add-member.js` | Primary | `mongosh … --file add-member.js` |
| `check-all.sh` | 아무 서버 | 전체 상태 점검 |

ERDCloud 가져오기용 DDL은 [`backend/db/erdcloud.sql`](../backend/db/erdcloud.sql).
