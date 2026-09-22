# video-recorder

네이버 프리미엄 콘텐츠(시황 등) 영상을 **Playwright(Edge) + OBS**로 자동 녹화하고, **구글 드라이브**에 업로드하는 도구.
같은 목록을 대상으로 **페이지 자체를 PNG로 캡처**하는 모드(`pnpm shot`)도 있다.
사이트는 **네이버 프리미엄콘텐츠**와 **나주다 인사이트 뷰(나인뷰, najuda.com)** 를 지원한다 — 사이트별로 다른 부분만 `src/sites/` 어댑터에 두고 나머지는 공용이다.
완료 여부는 드라이브를 기준으로 판단하며, 언제 멈춰도(항상 녹화 도중 STOP) 다음에 이어서 진행한다.

---

## 목차
1. [동작 개요](#동작-개요)
2. [최초 1회 세팅](#최초-1회-세팅)
3. [평소 사용법](#평소-사용법)
4. [명령어 전체](#명령어-전체)
5. [.env 설정](#env-설정)
6. [완료 판정·이어하기·안전장치](#완료-판정이어하기안전장치)
7. [폴더 구조](#폴더-구조)
8. [문제 해결](#문제-해결)
9. [다른 PC/서버에서 돌리기](#다른-pc서버에서-돌리기)

---

## 동작 개요

```
pnpm urls  →  카테고리 목록 페이지에서 (제목+URL)을 긁어 catalog(작업 큐)에 병합
pnpm start →  catalog의 "미완료"만 순서대로:
                Edge로 콘텐츠 열기 → 재생 → 1080p → 전체화면
              → OBS 녹화(화면+소리) → 끝(ended)까지 → 정지
              → 구글 드라이브 업로드(무결성 md5 검증) → 폰 알림

pnpm shot  →  같은 catalog를 순회하되 녹화 대신:
                Edge로 콘텐츠 열기 → 끝까지 스크롤(lazy 로딩) → 전체페이지 PNG 캡처
              → 드라이브 <catalog>-shots 폴더에 업로드 (OBS 불필요)
```

- **완료 기준 = 구글 드라이브에 그 영상 파일이 있음.** (로컬 파일 유무는 무관)
- 로컬 파일(`recordings/`)은 삭제하지 않고 보관하며, 재녹화 시 덮어쓴다.
- **Edge**를 쓰는 이유: 개인 크롬(chrome.exe)과 다른 앱(msedge.exe)이라 **오디오를 분리**할 수 있고, OBS가 개인 크롬을 잘못 잡지 않는다.
- **사이트는 URL로 자동 판별**한다(catalog에 따로 적지 않는다). 사이트마다 브라우저 프로필이 분리돼 있어(`.userdata-msedge`, `.userdata-msedge-najuda`) 네이버 녹화와 나인뷰 캡처를 한 PC에서 동시에 돌려도 서로 방해하지 않는다.

---

## 최초 1회 세팅

### 0) 완전 처음(깡통 Windows)이라면 — 도구 설치

Windows 11이면 `winget`(앱 설치 관리자)이 기본 탑재돼 있다. (`winget --version`이 안 되면 Microsoft Store에서 "앱 설치 관리자" 설치)

**① PowerShell 7 설치** — 기본 PowerShell(또는 cmd)에서:
```powershell
winget install --id Microsoft.PowerShell -e
```
설치 후 **`pwsh`**(PowerShell 7)를 실행하고, **이 아래 모든 명령은 pwsh에서** 진행한다.

**② 필수 도구 설치** — pwsh에서 Git · Node.js · OBS:
```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id OBSProject.OBSStudio -e
```

**③ 새 pwsh 창을 열고**(방금 설치한 것들 PATH 반영) 확인 + pnpm 활성화:
```powershell
git --version
node -v
corepack enable pnpm      # Node 내장. 안 되면: npm install -g pnpm
pnpm -v
```

**④ 저장소 받기(clone)** — 코드를 둘 위치에서:
```powershell
git clone https://github.com/kwop9296-lab/video-recorder.git
cd video-recorder
```
public 저장소라 인증 없이 받아진다. **이후 모든 명령은 이 `video-recorder` 폴더 안에서** 실행한다.

**⑤ 브라우저**: Microsoft **Edge**는 Windows에 기본 설치돼 있어 별도 설치 불필요 (`BROWSER=msedge` 사용).

### 1) 프로젝트 의존성 설치
이 프로젝트는 Playwright의 `channel: 'msedge'`로 **시스템에 설치된 Edge를 그대로 실행**한다 — Playwright 전용 브라우저(Chromium 등)를 따로 받을 필요가 없다.
그 자동 다운로드(수백MB~1GB, 우리 프로젝트엔 불필요)를 건너뛰도록 환경변수를 잡고 설치한다:
```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
pnpm install
```

### 2) `.env` 준비
```powershell
Copy-Item .env.example .env
```
그다음 아래 값을 채운다 (자세한 건 [.env 설정](#env-설정)):
- `BROWSER=msedge`
- `OBS_WS_PASSWORD=` (아래 OBS 설정에서 만든 비밀번호)
- `NTFY_TOPIC=` (아무거나 고유한 문자열)
- `GDRIVE_ROOT=` (드라이브 루트 폴더명, 예: `trading-npc`) — **필수**
- `GOOGLE_OAUTH_*` 3개 (구글 드라이브 업로드용)

### 3) Edge에서 네이버 로그인 (프로필 1회)
```powershell
pnpm setup:window "https://contents.premium.naver.com/no1/stock/contents/아무영상ID"
```
- Edge 창이 뜨면 **네이버 직접 로그인** ("로그인 상태 유지" 체크). 이후 `.userdata-msedge` 프로필에 유지된다.
- 영상이 1080p 전체화면으로 재생되면 OK. (이 창을 켜둔 채로 다음 OBS 설정 진행)

### 3') 나인뷰(najuda.com) 로그인 — 나인뷰를 쓸 때만
```powershell
pnpm signin najuda
```
- 네이버와 **다른 사이트·다른 계정**이라 로그인도 따로 한다. 프로필은 `.userdata-msedge-najuda` 로 분리 저장된다.
- 창이 뜨면 **직접 아이디/비밀번호 입력**. 이 도구는 비밀번호를 저장하지도 입력하지도 않는다.
- 로그인이 확인되면 등록된 목록 페이지를 열어준다 — 글이 잠금(🔒) 없이 보이면 정상. 확인 후 Ctrl+C.
- 나인뷰는 PHP 세션이라 네이버보다 만료가 잦다. 만료되면 `pnpm shot` 이 로그인 대기로 멈추고 ntfy로 🔐 알림이 온다 → `pnpm signin najuda` 로 다시 로그인.

### 4) OBS 설정
- **도구 → WebSocket 서버 설정**: 서버 활성화, 포트 `4455`, 비밀번호 설정 → `.env`의 `OBS_WS_PASSWORD`에 입력
- **설정 → 비디오**: 캔버스/출력 `1920x1080`, `30`fps
- **설정 → 출력 → 녹화**: 형식 `mkv`, 인코더 하드웨어(QSV 등) 또는 "높은 품질"
- **소스**:
  - **윈도우 캡처**: 캡처 방법 `Windows Graphics Capture`, 윈도우 `[msedge.exe]: REC-AUTOMATION ...`, 창 일치 우선순위 `창 제목이 일치해야 함` → 소스 우클릭 → 변형 → **화면에 맞추기(Ctrl+F)**
  - **응용 프로그램 오디오 캡처**: 같은 `REC-AUTOMATION` 창 선택
- 검증:
  ```powershell
  pnpm obs:check          # 연결 + 해상도/장면 확인
  pnpm obs:check --rec    # 5초 테스트 녹화 (화면+소리 담기는지)
  ```

### 5) 오디오 분리 (VB-CABLE)
녹화 중 소리를 **안 듣되 파일엔 녹음**되게:
1. **vb-audio.com/Cable**에서 기본 VB-CABLE 설치 → 재부팅
2. Edge 재생 중 상태에서 **설정 → 시스템 → 소리 → 볼륨 믹서 → Microsoft Edge → 출력 장치 = `CABLE Input`**
   - Edge 소리는 스피커로 안 나가고(안 들림), OBS는 프로세스 소리를 그대로 녹음, 개인 크롬은 스피커 유지.

### 6) ntfy 앱
- 폰에 **ntfy** 앱 설치 → `.env`의 `NTFY_TOPIC`과 같은 토픽 구독.
- 완료/실패/로그인필요/STOP 알림이 온다. (`NTFY_TOPIC` 비우면 알림만 꺼짐)

---

## 평소 사용법

```powershell
# 1) 최초 1회만 — 카테고리 목록 URL에 이름 붙이기 (data/sources.json 에 자동 등록)
pnpm urls "https://contents.premium.naver.com/no1/stock/contents?categoryId=..." no1-stock

# 1') 이후엔 이름만 — URL을 다시 찾을 필요 없다
pnpm urls no1-stock
pnpm urls all            # 등록된 catalog 전부, 브라우저 한 번만 띄워 순차 갱신
pnpm urls                # 등록된 이름/URL 목록 보기

# 2) 녹화 시작 (미완료만 → 드라이브 업로드)
pnpm start no1-stock

# 언제든 Ctrl+C 로 중단 — 진행 중 영상은 버려지고, 완료된 건 드라이브에 남음.
# 다시 pnpm start 하면 완료분은 건너뛰고 이어서 진행.
```

- `pnpm urls`는 **병합**이라 여러 번 돌려도 기존 목록·진행상황이 안 날아간다. 새 영상만 추가된다.
- 순서는 실행할 때마다 **사이트 목록 순서(최신이 위)로 다시 잡힌다** → 새로 올라온 영상이 catalog 맨 위에 오고 `pnpm start`가 **최신부터** 녹화한다. 출력 맨 위의 `🆕 신규 N개`로 이번에 뭐가 늘었는지 바로 확인할 수 있다.
- 사이트 목록에서 사라진 항목(비공개 전환 등)도 지우지 않고 맨 아래에 남긴다.
- 새 대상이 생기면 다른 이름으로: `pnpm urls "<다른카테고리URL>" other-name` → `pnpm start other-name`
- 이름↔URL 매핑은 `data/sources.json`에 쌓인다(`data/`는 git 제외 → **PC별 로컬 설정**). 같은 이름을 다른 URL로 다시 돌리면 그 URL로 갱신된다.
- `pnpm urls all`은 한 대상이 실패해도 멈추지 않고 나머지를 계속 돌린 뒤, 맨 끝에 이름별 `신규/남음` 요약을 찍는다.
- ⚠ **같은 사이트의 명령을 동시에 돌리지 말 것** — 사이트별로 브라우저 프로필이 하나라, 나중 실행이 돌아가던 창에 빈 탭을 열어 창 제목이 바뀌고 **OBS 캡처가 끊긴다**. 실수로 겹치면 나중 명령이 `자동화 브라우저가 이미 실행 중입니다` 로 멈추도록 막아두었다. (네이버 녹화 + 나인뷰 캡처처럼 **다른 사이트**끼리는 프로필이 달라 동시에 돌려도 된다)
- **테스트**: `.env`의 `MAX_RECORD_SEC=60` 이면 각 영상을 60초만 녹화. 실제 운영은 **비워둔다**.

**나인뷰(najuda.com)** 도 같은 명령을 쓴다 — 코스 탭 URL을 그대로 등록하면 된다:
```powershell
pnpm signin najuda                                                          # 최초 1회
pnpm urls "https://najuda.com/nainview/course.php?nv_course_id=6&tab=38" mimosa
pnpm shot mimosa                                                           # 캡처 (OBS 불필요)
```
- 탭(카테고리) 하나가 catalog 하나다. 다른 탭도 받고 싶으면 다른 이름으로 한 번 더 등록한다.
- 목록은 무한스크롤이 아니라 **20개씩 페이지**라, 수집기가 `&page=2,3,...` 를 끝까지 따라간다.
- 글 ID는 URL 경로가 아니라 **`board_id`+`no`** 로 잡는다(`b38-n12`). `/nineview/`·`/nainview/` 두 경로가 같은 글이라 경로로 잡으면 중복되기 때문.
- 글 안의 영상은 **캡처 대상이 아니다** — 페이지에 보이는 그대로(정지화면)만 남는다.

#### 같은 사이트, 다른 아이디 (`--account`)

탭마다 보이는 콘텐츠가 다른 여러 계정을 쓸 때. **등록할 때 한 번만** 지정하면 그 catalog는 이후 항상 그 계정으로 돈다.

```powershell
# 두 번째 아이디로 로그인 (프로필이 따로 잡힘)
pnpm signin najuda --account=sub

# 그 계정으로 볼 탭을 등록 — 계정이 data/sources.json 에 함께 기록된다
pnpm urls "https://najuda.com/nainview/course.php?nv_course_id=6&tab=41" drmroad --account=sub

# 이후엔 --account 를 안 붙여도 알아서 sub 계정으로 돈다
pnpm urls drmroad
pnpm shot drmroad
```

- 프로필·창 제목이 계정별로 갈린다: `.userdata-msedge-najuda-sub` / `REC-AUTOMATION-NAJUDA-SUB`. 두 계정을 **동시에** 돌려도 세션이 안 섞인다.
- 드라이브 폴더는 catalog 이름 기준이라 탭별로 이미 분리된다. **계정이 다르면 catalog 이름도 다르게** 둘 것 — 같은 이름을 쓰면 서로의 결과를 "이미 완료"로 보고 건너뛴다.
- 임시로 다른 계정으로 돌려보고 싶으면 `--account=` 를 붙이거나 `.env`/환경변수 `PROFILE` 을 쓴다 (우선순위: `--account` > `PROFILE` > catalog에 기록된 값).
- 계정 이름은 폴더명이 되므로 영문·숫자·`-`·`_` 만 남는다 (`Sub 2` → `sub-2`).

### 페이지 캡처 (`pnpm shot`)

영상 대신 **페이지 자체를 PNG로 캡처**하는 별도 모드. catalog는 녹화와 **같은 것을 쓴다**.

```powershell
pnpm shot no1-stock
```

- 같은 페이지에 접속하지만 **재생·1080p·전체화면·OBS를 전혀 쓰지 않는다.** OBS가 꺼져 있어도 된다.
- 페이지를 **끝까지 스크롤**해 lazy 이미지를 모두 불러온 뒤, 맨 위로 돌아와 **전체페이지 한 장**으로 찍는다.
- 항목당 수 초라 녹화보다 훨씬 빠르다. `reverse`·`FORCE=1`·두 PC 분담 모두 녹화와 동일하게 동작.
- **캡처 대상은 catalog 전체 항목** — 녹화에서 `novideo`로 걸러진 것도 포함한다(영상이 없어도 글은 있으므로).
- **완료 판정은 녹화와 완전히 분리**돼 있다: 드라이브의 `<catalog>-shots` 폴더 기준. 녹화 완료 여부에 영향을 주지도 받지도 않는다.
- 결과물 폭은 **항상 1440px 고정**(모니터 해상도와 무관) — 두 PC로 나눠 돌려도 같은 크기로 나온다.
- 문서가 아주 길어 한 장 한계(약 16000px)를 넘으면 **나눠 찍은 뒤 세로로 이어붙여 다시 한 장으로** 만든다(`sharp`). 결과는 `<제목>.png` 하나 — 길이가 얼마든 **글 하나 = 파일 하나**다.
- 이어붙이기 한도는 60000px(`config.capture.stitchMaxHeight`). 그보다 긴 문서이거나 `sharp` 가 없으면 조각(`<제목>_1.png`, `_2.png`…) 그대로 남기며, 이때는 **전부 업로드된 뒤에야** 완료로 친다(중간에 끊기면 다음 실행에서 다시 캡처).
- 알림은 항목마다 오지 않고 **세션 끝에 요약 1건** + 실패 시 개별 알림.
- 로컬 보관: `captures/<catalog>/<제목>.png`

---

## 명령어 전체

| 명령 | 설명 |
|---|---|
| `pnpm urls <catalog> [catalog...]` | **등록된** URL로 catalog 병합 (최신순 재정렬, 신규 표시, ✅완료/⏭영상없음/⬜남음) |
| `pnpm urls all` | 등록된 catalog 전부 갱신 (브라우저 1회 실행으로 순차 처리) |
| `pnpm urls "<URL>" <catalog>` | URL을 이름에 등록(`data/sources.json`) + 갱신 — 최초 1회 |
| `pnpm urls` | 등록된 이름/URL 목록 보기 |
| `pnpm signin <사이트\|catalog\|URL>` | 그 사이트 프로필에 로그인 창 띄우기 (최초 1회·세션 만료 시). 예: `pnpm signin najuda` |
| `--account=<이름>` | 위 `urls`/`shot`/`start`/`login` 공통 옵션 — 같은 사이트의 다른 아이디. 등록 시 한 번 주면 이후 자동 |
| `pnpm start [catalog] [reverse]` | catalog의 미완료 녹화 → 드라이브 업로드 (catalog 하나면 이름 생략 가능). `reverse`(=`-r`/`desc`): 아래에서부터 녹화 |
| `pnpm shot [catalog] [reverse]` | catalog 페이지를 PNG로 캡처 → `<catalog>-shots` 폴더에 업로드. OBS 불필요. 인자 규칙은 `start`와 동일 |
| `pnpm obs:check [--rec]` | OBS 연결/해상도 확인 (`--rec`: 5초 테스트 녹화) |
| `pnpm setup:window "<URL>"` | OBS 설정용으로 Edge 창을 재생만 시켜 띄움 (녹화 X) |
| `pnpm spike ["<URL>"]` | 플레이어 신호/컨트롤 관찰용 대화형 도구 (디버깅) |
| `pnpm discover "<URL>"` | HLS/DASH 매니페스트 분석 (직접 다운로드 방식 조사용) |
| `pnpm download` | (대안) OBS 없이 스트림 직접 다운로드 — `data/videos.json` 사용 |

환경변수 스위치: `FORCE=1`(완료분도 재녹화), `HEADLESS=1`(창 없이 — 서버용, 주로 download에), `MAX_RECORD_SEC=60`(테스트).
PowerShell 예: `$env:FORCE=1; pnpm start no1-stock`

### 두 PC로 나눠 녹화 (위/아래 분담)

같은 catalog를 두 대에서 동시에 돌리면 대략 2배 빠르게 끝낼 수 있다. 한쪽은 위에서부터, 다른쪽은 아래에서부터:

```
# PC-A (위 → 아래, 기본)
pnpm start no1-stock

# PC-B (아래 → 위)
pnpm start no1-stock reverse
```

- 완료 판정 기준은 여전히 **드라이브에 파일 존재**라, 서로의 진행상황을 공유할 필요가 없다.
- 각 항목 녹화 **직전에 드라이브를 재확인**해서, 두 PC가 중간에서 만나도 이미 올라온 건 건너뛴다(중복 녹화 방지). 정확히 동시에 같은 걸 시작한 항목만 드물게 중복될 수 있다.
- 중간에 `pnpm urls`를 다시 돌리면 catalog 순서가 최신순으로 다시 잡히면서 위/아래 경계가 조금 움직인다. 위의 직전 재확인 덕에 **중복 녹화는 안 나고**, 헛도는 항목만 몇 개 생긴다. 신경 쓰인다면 두 PC 모두 같은 시점의 catalog로 맞추면 된다.

---

## .env 설정

| 변수 | 필수 | 설명 |
|---|---|---|
| `BROWSER` | | `chrome` \| `msedge`. 오디오 분리하려면 `msedge`. |
| `OBS_WS_URL` | | 기본 `ws://127.0.0.1:4455` |
| `OBS_WS_PASSWORD` | ✔(녹화) | OBS WebSocket 비밀번호 |
| `OBS_SCENE` | | 지정 시 녹화 전 이 장면으로 전환 |
| `RECORD_DIR` | | 로컬 저장 폴더 (기본 `./recordings`) |
| `CAPTURE_DIR` | | 캡처 저장 폴더 (기본 `./captures`) |
| `MAX_RECORD_SEC` | | >0이면 그 초수에서 강제 종료(테스트). 운영은 비움 |
| `PROFILE` | | 계정(프로필) 꼬리표를 전역으로 덮어쓰기. 보통은 `--account=` 나 catalog 기록을 쓰고, 이건 임시 override 용 |
| `NTFY_TOPIC` | | ntfy 알림 토픽 (비우면 알림 끔) |
| `GDRIVE_ROOT` | ✔ | 드라이브 루트 폴더명. **없으면 `start`/`shot`/`urls` 실행 거부** |
| `GOOGLE_OAUTH_CLIENT_ID` | ✔ | 구글 OAuth (drive.file 스코프) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | ✔ | 〃 |
| `GOOGLE_OAUTH_REFRESH_TOKEN` | ✔ | 〃 |

> `.env`는 `.gitignore`에 있어 git에 올라가지 않는다 (비밀값 안전).

---

## 완료 판정·이어하기·안전장치

- **완료 = 드라이브에 파일 존재** (파일에 `contentId` 메타를 붙여 URL↔완료를 정확히 매칭). 로컬 파일 유무와 무관.
- **이어하기**: `start`는 매번 드라이브를 조회해 완료분을 건너뛰고 미완료만 진행. STOP 후 다시 켜면 자연스럽게 이어감.
- **STOP은 항상 녹화 도중**: `Ctrl+C` 시 OBS 정지 + **진행 중 영상 폐기**(업로드/완료 처리 안 함) + STOP 알림. → 어중간한 파일이 드라이브에 안 올라간다.
- **무결성**: 업로드 후 로컬과 **md5 대조**. 불일치면 드라이브 파일 삭제 + 실패 처리(다음에 재녹화).
- **앞뒤 짤림 방지**: OBS가 실제 "녹화 중"이 된 뒤 재생 시작, `ended` 후 여유를 두고 정지.
- **영상 없는 페이지**: 자동 스킵하고 catalog에 `novideo` 기록 → 다음엔 즉시 건너뜀.
- **로컬 파일**: 삭제 안 함. `recordings/<제목>.mkv` (재녹화 시 덮어씀).
- **캡처(`pnpm shot`)는 별도 폴더 `<catalog>-shots` 기준**이라 녹화 완료 판정과 서로 간섭하지 않는다. 항목이 원자적(캡처를 다 끝낸 뒤 업로드)이라 STOP 해도 진행 중 항목만 버리면 되고, 분할된 여러 장은 **마지막 장까지 올라가야** 완료로 인정된다.

---

## 폴더 구조

```
video-recorder/
├─ .env                      # 설정(비밀값 포함, git 제외)
├─ data/catalogs/<이름>.json  # 종류별 작업 큐 [{id,title,url,skip?,done?}]
├─ data/sources.json         # 이름 → { 목록 URL, 계정 } (pnpm urls <이름> 용, git 제외)
├─ recordings/               # 로컬 보관본 <제목>.mkv
├─ captures/<catalog>/       # 로컬 캡처본 <제목>.png
├─ .userdata-msedge/         # Edge 프로필(네이버 로그인 세션, git 제외)
├─ .userdata-msedge-najuda/  # Edge 프로필(나인뷰 로그인 세션, git 제외)
├─ .userdata-msedge-najuda-sub/  # 〃 두 번째 아이디(--account=sub)
└─ src/
   ├─ index.js               # 진입점 (pnpm start)
   ├─ capture.js             # 진입점 (pnpm shot)
   ├─ list.js                # pnpm urls
   ├─ signin.js              # pnpm signin (로그인 창)
   ├─ sites/                 # 사이트 어댑터 (naver·najuda) — 로그인 판정/목록 수집/콘텐츠 ID
   ├─ orchestrator.js        # 지휘: 미완료 순회→녹화→업로드
   ├─ captureOrchestrator.js # 지휘(캡처): 미완료 순회→PNG 캡처→업로드
   ├─ browser/               # session(로그인)·navigator·videoProbe(재생/신호)·pageCapture
   ├─ recorder/obsRecorder   # OBS 제어
   ├─ drive/                 # 구글 드라이브(OAuth+업로드)
   └─ core/                  # config·catalog·sources(이름→URL)·notify(ntfy)·logger·filename

구글 드라이브:  내 드라이브 / <GDRIVE_ROOT> / <catalog>       / <제목>.mkv   ← 녹화
              내 드라이브 / <GDRIVE_ROOT> / <catalog>-shots / <제목>.png   ← 캡처
```

---

## 문제 해결

| 증상 | 원인·해결 |
|---|---|
| `자동화 브라우저가 이미 실행 중입니다` | 같은 프로필(`.userdata-*`)을 쓰는 Edge가 떠 있다. **녹화/캡처가 도는 중이면 끝난 뒤에** 실행할 것. 아무것도 안 도는데 뜨면(Ctrl+C 로 끊어 남은 유령 프로세스) 같은 명령에 `--kill-browser` 를 붙여 재실행 |
| `GDRIVE_ROOT 미설정` | `.env`에 `GDRIVE_ROOT` 지정 |
| `구글 OAuth 자격증명 없음` | `.env`에 `GOOGLE_OAUTH_*` 3개 확인 |
| 시작 시 로그인 페이지가 뜸 | 세션 만료 → 열린 Edge 창에서 재로그인(네이버는 “로그인 상태 유지” 체크). ntfy로 🔐 알림도 옴. 미리 하려면 `pnpm signin <사이트>` |
| 나인뷰가 자꾸 로그아웃됨 | PHP 세션이라 수명이 짧다. 캡처 시작 전에 `pnpm signin najuda` 로 한 번 갱신하고 돌리면 세션 중간에 멈추지 않는다 |
| 나인뷰 목록이 **20개만** 잡힘 | 페이지네이션(`&page=`)을 못 따라간 것. 목록 URL에 이미 `page=` 가 붙어 있으면 빼고 등록할 것 |
| 다른 아이디로 등록했는데 **잠긴 글**만 보임 | 그 catalog에 계정이 안 적힌 것. `pnpm urls` 로 등록 목록을 보면 `[계정: sub]` 표시가 있는지 확인. 없으면 `pnpm urls <이름> --account=sub` 로 한 번 갱신 |
| OBS 녹화가 **검은 화면** | 윈도우 캡처를 `Windows Graphics Capture` + `REC-AUTOMATION`으로. 아니면 화면 캡처로 |
| 녹화에 **소리 없음/이중음** | 오디오 소스를 응용 프로그램 오디오 캡처 하나만. VB-CABLE 라우팅 확인 |
| 소리가 **스피커로 들림** | 볼륨 믹서에서 Edge 출력 = `CABLE Input` 인지 확인 |
| `urls` 제목이 "동영상"만 | 목록 페이지 구조가 다름 → 그 페이지 HTML 공유해 셀렉터 조정 |
| 알림이 안 옴 | `NTFY_TOPIC` 설정 + 폰 앱에서 같은 토픽 구독 확인 |
| `shot` 캡처에 **이미지가 빈칸** | lazy 로딩이 덜 걸린 것. 본문이 페이지가 아닌 내부 컨테이너에서 스크롤되는 구조일 수 있다 → 그 셀렉터 확인 후 `pageCapture.js`의 스크롤 대상 조정 |
| `shot` 결과가 **여러 장으로 쪼개짐** | 문서가 60000px을 넘었거나 `sharp` 설치가 안 된 것. 보통은 나눠 찍은 뒤 한 장으로 이어붙인다 (`config.capture.stitch` / `stitchMaxHeight`) |
| `shot` 이 같은 항목을 **매번 다시 캡처** | 분할 업로드가 중간에 끊겨 완료 표식이 안 붙은 것. 실패 알림의 사유를 확인 (네트워크/용량) |
| 업로드 중 `HTTP 502` / `ECONNRESET` | 구글 쪽 일시적 오류. 2→4→8→16초로 **자동 재시도**하고(`↻` 로그), 그래도 안 되면 그 항목만 실패로 남겨 다음 실행에서 재시도한다 |
| 업로드가 `HTTP 403` 으로 **즉시** 실패 | 속도 제한이 아니라 권한 문제(재시도해도 소용없음) → `GOOGLE_OAUTH_*` 와 드라이브 접근 권한 확인 |

---

## 다른 PC/서버에서 돌리기

- **`.env`만 복사**하면 됨 (구글 OAuth·GDRIVE_ROOT·NTFY 모두 포함, 자체 완결). market-viewer 등 다른 프로젝트 불필요.
- 단, OBS 방식은 **화면이 실제로 그려지는 환경**(GUI + 오디오 장치)이 필요하다 — 헤드리스 서버엔 그대로 안 올라간다.
- 서버/무인 고려사항은 별도 논의 대상 (데이터센터 IP로 세션 쓰면 네이버가 민감할 수 있음 → 집 IP 권장).
