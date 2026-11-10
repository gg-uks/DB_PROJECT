// MongoDB 복제 세트 rs0에 .25 추가 — Primary에 admin으로 접속해서 실행
//   mongosh "mongodb://admin:<ADMIN_PASSWORD>@192.168.56.22:27017,192.168.56.24:27017/?replicaSet=rs0&authSource=admin" --file add-member.js
rs.add("192.168.56.25:27017");
sleep(3000);
printjson(rs.status().members.map(m => [m.name, m.stateStr, m.health]));

// 앱 전용 계정 (처음 한 번만 · 이미 있으면 건너뜀)
const app = db.getSiblingDB("playlog");
if (!app.getUser("playlog")) {
  app.createUser({ user: "playlog", pwd: "<MONGO_PASSWORD>", roles: [{ role: "readWrite", db: "playlog" }] });
}
