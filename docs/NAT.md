# NAT 게이트웨이 설정 문서

> 작성: 황시영 · 2026-11-11 · 실제 설정 파일: [`infra/vm/nat/`](../infra/vm/nat/)

## 구조

![NAT 구조 · nat-gw 랜카드 3개, 내부 서버 11대](images/nat.png)

내부 서버가 인터넷에 나갈 때는 enp0s8 → enp0s3을 거치고, 강의실 PC가 들어올 때는 enp0s9 → enp0s8을 거칩니다. 그래서 nat-gw가 꺼지면 두 방향 모두 끊겨요.

## nat-gw 설정 (1~7단계)

nat-gw 한 대가 **내부 서버들의 인터넷 출구**이자 **강의실 PC의 접속 입구** 역할을 합니다. 11/07에 기본 NAT를 구성했고, 11/09에 브리지 IP 고정과 포트포워딩을 추가했어요. OS는 Rocky Linux 10이고 방화벽은 firewalld를 씁니다.

### 1. VirtualBox 랜카드 3개 (11/07)

| 어댑터 | 연결 방식 | 리눅스 이름 | IP | 역할 |
|---|---|---|---|---|
| 1 | NAT | enp0s3 | 10.0.2.15 (VirtualBox가 부여) | 인터넷 출구 |
| 2 | 호스트 전용 | enp0s8 | 192.168.56.2 | 내부 서버들의 게이트웨이 |
| 3 | 어댑터에 브리지 | enp0s9 | 192.168.0.224 | 강의실 PC 접속 입구 |

### 2. IP 포워딩 켜기 (11/07)

리눅스가 한 랜카드로 들어온 패킷을 다른 랜카드로 넘길 수 있게 합니다. 파일로 저장해서 재부팅해도 유지돼요.

```bash
echo "net.ipv4.ip_forward = 1" > /etc/sysctl.d/99-ipforward.conf
sysctl -p /etc/sysctl.d/99-ipforward.conf
```

### 3. 방화벽 존 지정 (11/07)

바깥쪽 랜카드는 external, 안쪽 랜카드는 internal 존에 넣습니다.

```bash
nmcli con mod enp0s3 connection.zone external
nmcli con mod enp0s9 connection.zone external
nmcli con mod enp0s8 connection.zone internal
```

### 4. 마스커레이드 (11/07)

NAT의 핵심이에요. 내부 서버(192.168.56.x)가 보낸 패킷의 출발지 IP를 nat-gw의 IP로 바꿔서 내보내고, 돌아온 응답을 다시 원래 서버로 돌려줍니다.

```bash
firewall-cmd --permanent --zone=external --add-masquerade
```

### 5. 내부 → 외부 통과 정책 int2ext (11/07)

firewalld는 기본적으로 존 사이 이동을 막아서, internal에서 external로 나가는 것을 허용하는 정책을 따로 만들었어요.

```bash
firewall-cmd --permanent --new-policy int2ext
firewall-cmd --permanent --policy int2ext --add-ingress-zone internal
firewall-cmd --permanent --policy int2ext --add-egress-zone external
firewall-cmd --permanent --policy int2ext --set-target ACCEPT
```

### 6. 브리지 IP 고정 (11/09)

공유기 DHCP로 받으면 재부팅 때마다 주소가 바뀔 수 있어서 192.168.0.224로 고정했어요. `never-default yes`는 인터넷 출구를 enp0s3 하나로 유지하기 위한 설정입니다.

```bash
nmcli con mod enp0s9 ipv4.method manual ipv4.addresses 192.168.0.224/24 \
  ipv4.gateway "" ipv4.never-default yes ipv6.method disabled
nmcli con up enp0s9
```

### 7. 포트포워딩 (11/09)

강의실 PC가 192.168.0.224:포트로 들어오면 해당 내부 서버로 전달합니다. 규칙은 **외부 포트 끝 두 자리 = 내부 IP 끝자리**예요. 전체 목록은 아래 [접속 포트 표](#접속-포트-표)에 있어요.

```bash
for pair in 2210:10 2211:11 2212:12 2221:21 2222:22 2223:23 2224:24 2231:31 2233:33 2241:41 2242:42; do
  firewall-cmd --permanent --zone=external \
    --add-forward-port=port=${pair%%:*}:proto=tcp:toaddr=192.168.56.${pair##*:}:toport=22
done
firewall-cmd --permanent --zone=external --add-forward-port=port=80:proto=tcp:toaddr=192.168.56.10:toport=80
firewall-cmd --permanent --zone=external --add-forward-port=port=8404:proto=tcp:toaddr=192.168.56.10:toport=8404
firewall-cmd --permanent --zone=external --add-forward-port=port=5601:proto=tcp:toaddr=192.168.56.33:toport=5601
firewall-cmd --permanent --zone=external --add-forward-port=port=3000:proto=tcp:toaddr=192.168.56.42:toport=3000
firewall-cmd --reload
```

## 내부 서버 설정 (8단계)

nat-gw를 제외한 모든 서버는 **기본 경로를 nat-gw(192.168.56.2)로** 바꿨어요 (11/09). 각 서버의 VirtualBox NAT(enp0s3)는 끊지 않고 기본 경로에서만 내렸기 때문에, 문제가 생기면 바로 되돌릴 수 있습니다.

### 8. 기본 경로 전환 (각 서버에서)

```bash
C3=$(nmcli -g GENERAL.CONNECTION device show enp0s3)
C8=$(nmcli -g GENERAL.CONNECTION device show enp0s8)
nmcli con mod "$C8" ipv4.never-default no ipv4.gateway 192.168.56.2 ipv4.dns "8.8.8.8 1.1.1.1"
nmcli con mod "$C3" ipv4.never-default yes ipv4.ignore-auto-dns yes
nmcli device reapply enp0s3; nmcli device reapply enp0s8
```

| 설정 | 랜카드 | 의미 |
|---|---|---|
| `ipv4.gateway 192.168.56.2` | enp0s8 | 인터넷으로 나갈 때 nat-gw를 거침 |
| `ipv4.never-default no` | enp0s8 | 이 랜카드를 기본 경로로 사용 |
| `ipv4.dns 8.8.8.8 1.1.1.1` | enp0s8 | 도메인 이름 조회용 DNS |
| `ipv4.never-default yes` | enp0s3 | VirtualBox NAT는 기본 경로에서 제외 |
| `ipv4.ignore-auto-dns yes` | enp0s3 | VirtualBox NAT가 주는 DNS는 쓰지 않음 |

적용한 서버: lb-server, web-app-1, web-app-2, mysql-source, mysql-replica, mongo-1, mongo-2, mw, es, backup, monitor. 새로 만드는 서버(mongo-3 등)도 같은 명령을 실행하고, 강의실 접속이 필요하면 7단계 포트포워딩을 추가하면 됩니다.

## 접속 포트 표

강의실 PC에서는 **주소 192.168.0.224 하나**로 들어가고 포트로 서버를 고릅니다. 예: `ssh -p 2221 root@192.168.0.224` → mysql-source

| 서버 | 내부 IP | SSH 포트 | 웹 화면 |
|---|---|---|---|
| nat-gw | 192.168.56.2 | 22 | - |
| lb-server | 192.168.56.10 | 2210 | 웹 :80, HAProxy 통계 :8404/stats |
| web-app-1 | 192.168.56.11 | 2211 | - |
| web-app-2 | 192.168.56.12 | 2212 | - |
| mysql-source | 192.168.56.21 | 2221 | - |
| mongo-1 | 192.168.56.22 | 2222 | - |
| mysql-replica | 192.168.56.23 | 2223 | - |
| mongo-2 | 192.168.56.24 | 2224 | - |
| mw | 192.168.56.31 | 2231 | - |
| es | 192.168.56.33 | 2233 | Kibana :5601 |
| backup | 192.168.56.41 | 2241 | - |
| monitor | 192.168.56.42 | 2242 | Grafana :3000 |

DB 포트(3306, 27017)는 보안을 위해 바깥에 열지 않았어요. DBeaver나 Compass로 접속할 때는 해당 서버의 SSH 포트로 **SSH 터널**을 걸어서 들어갑니다.

## 확인 방법

내부 서버에서 `ping 8.8.8.8`의 **ttl이 62**로 나오면 nat-gw를 한 번 거쳐 나간 것이라 NAT가 정상입니다. 11/09에 11대 전부 이 값으로 확인했고, nat-gw 재부팅 후에도 설정이 그대로 유지됐어요.

| 어디서 | 명령 | 정상 결과 |
|---|---|---|
| nat-gw | `firewall-cmd --get-active-zones` | external: enp0s3 enp0s9 / internal: enp0s8 |
| nat-gw | `firewall-cmd --zone=external --query-masquerade` | yes |
| nat-gw | `sysctl net.ipv4.ip_forward` | 1 |
| nat-gw | `firewall-cmd --zone=external --list-forward-ports \| wc -l` | 15 |
| 내부 서버 | `ip route get 8.8.8.8` | via 192.168.56.2 dev enp0s8 |
| 내부 서버 | `ping -c 2 8.8.8.8` | 응답 오고 ttl=62 |
| 강의실 PC | `ssh -p 2221 root@192.168.0.224` | `[root@mysql-source ~]#` |

## 문제 해결

| 증상 | 원인 / 해결 |
|---|---|
| 내부 서버에서 인터넷(dnf, curl)이 안 됨 | nat-gw가 꺼져 있거나 masquerade가 빠짐. nat-gw를 먼저 켜고 위 확인 명령으로 점검 |
| 강의실 PC에서 SSH timed out | `ping 192.168.0.224`부터 확인. 되는데 안 되면 그 서버가 8단계를 안 한 것 (응답이 nat-gw로 안 돌아감) |
| REMOTE HOST IDENTIFICATION HAS CHANGED | 주소는 같고 포트만 다른 서버라서 생김. `ssh-keygen -R "[192.168.0.224]:2221"` (포트만 바꿔서) |
| VM 켤 때 인터넷이 늦게 됨 | **nat-gw를 가장 먼저** 켜기. 순서: nat-gw → DB → mw·es → web → lb → monitor |

**내부 서버를 원래대로 되돌리는 명령** (해당 서버에서, 각자 VirtualBox NAT로 다시 나감)

```bash
nmcli con mod "$(nmcli -g GENERAL.CONNECTION device show enp0s8)" ipv4.never-default yes ipv4.gateway ""
nmcli con mod "$(nmcli -g GENERAL.CONNECTION device show enp0s3)" ipv4.never-default no ipv4.ignore-auto-dns no
nmcli device reapply enp0s3; nmcli device reapply enp0s8
```
