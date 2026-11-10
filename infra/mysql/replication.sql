-- MySQL Source(.21) → Replica(.23) GTID 복제 설정
-- ① Source(.21): 복제 전용 계정
CREATE USER 'repl'@'192.168.56.%' IDENTIFIED BY '<REPL_PASSWORD>';
GRANT REPLICATION SLAVE ON *.* TO 'repl'@'192.168.56.%';

-- ② Source → Replica 초기 데이터 맞추기 (셸)
--   (.21) mysqldump -u root -p --all-databases --single-transaction --triggers --routines --events > all.sql
--   (.23) SET GLOBAL super_read_only = OFF;  RESET BINARY LOGS AND GTIDS;  SOURCE all.sql;

-- ③ Replica(.23): 복제 시작
CHANGE REPLICATION SOURCE TO
  SOURCE_HOST = '192.168.56.21',
  SOURCE_USER = 'repl',
  SOURCE_PASSWORD = '<REPL_PASSWORD>',
  SOURCE_AUTO_POSITION = 1,
  GET_SOURCE_PUBLIC_KEY = 1;
START REPLICA;
SET GLOBAL super_read_only = ON;

-- ④ 확인: Replica_IO_Running = Yes · Replica_SQL_Running = Yes · Seconds_Behind_Source = 0
SHOW REPLICA STATUS\G

-- ⑤ 앱 계정 (Source에서 만들면 Replica로 복제됨)
CREATE USER 'playlog'@'192.168.56.%' IDENTIFIED BY '<MYSQL_PASSWORD>';
GRANT ALL PRIVILEGES ON steam.* TO 'playlog'@'192.168.56.%';
