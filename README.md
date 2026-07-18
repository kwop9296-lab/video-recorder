# video-recorder

네이버 프리미엄 콘텐츠(시황 등) 영상을 **Playwright(Edge) + OBS**로 자동 녹화하고, **구글 드라이브**에 업로드하는 도구.
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
```

- **완료 기준 = 구글 드라이브에 그 영상 파일이 있음.** (로컬 파일 유무는 무관)
- 로컬 파일(`recordings/`)은 삭제하지 않고 보관하며, 재녹화 시 덮어쓴다.
- **Edge**를 쓰는 이유: 개인 크롬(chrome.exe)과 다른 앱(msedge.exe)이라 **오디오를 분리**할 수 있고, OBS가 개인 크롬을 잘못 잡지 않는다.

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
# 1) 카테고리 목록 → catalog 로 (종류별 이름 부여)
pnpm urls "https://contents.premium.naver.com/no1/stock/contents?categoryId=..." no1-stock

# 2) 녹화 시작 (미완료만 → 드라이브 업로드)
pnpm start no1-stock

# 언제든 Ctrl+C 로 중단 — 진행 중 영상은 버려지고, 완료된 건 드라이브에 남음.
# 다시 pnpm start 하면 완료분은 건너뛰고 이어서 진행.
```

- `pnpm urls`는 **병합**이라 여러 번 돌려도 기존 목록·진행상황이 안 날아간다. 새 영상만 추가된다.
- 새 대상이 생기면 다른 이름으로: `pnpm urls "<다른카테고리URL>" other-name` → `pnpm start other-name`
- **테스트**: `.env`의 `MAX_RECORD_SEC=60` 이면 각 영상을 60초만 녹화. 실제 운영은 **비워둔다**.

---

## 명령어 전체

| 명령 | 설명 |
|---|---|
| `pnpm urls "<URL>" <catalog>` | 카테고리 목록 → catalog 병합 (제목+URL, ✅/⬜ 표시) |
| `pnpm start [catalog]` | catalog의 미완료 녹화 → 드라이브 업로드 (catalog 하나면 이름 생략 가능) |
| `pnpm obs:check [--rec]` | OBS 연결/해상도 확인 (`--rec`: 5초 테스트 녹화) |
| `pnpm setup:window "<URL>"` | OBS 설정용으로 Edge 창을 재생만 시켜 띄움 (녹화 X) |
| `pnpm spike ["<URL>"]` | 플레이어 신호/컨트롤 관찰용 대화형 도구 (디버깅) |
| `pnpm discover "<URL>"` | HLS/DASH 매니페스트 분석 (직접 다운로드 방식 조사용) |
| `pnpm download` | (대안) OBS 없이 스트림 직접 다운로드 — `data/videos.json` 사용 |

환경변수 스위치: `FORCE=1`(완료분도 재녹화), `HEADLESS=1`(창 없이 — 서버용, 주로 download에), `MAX_RECORD_SEC=60`(테스트).
PowerShell 예: `$env:FORCE=1; pnpm start no1-stock`

---

## .env 설정

| 변수 | 필수 | 설명 |
|---|---|---|
| `BROWSER` | | `chrome` \| `msedge`. 오디오 분리하려면 `msedge`. |
| `OBS_WS_URL` | | 기본 `ws://127.0.0.1:4455` |
| `OBS_WS_PASSWORD` | ✔(녹화) | OBS WebSocket 비밀번호 |
| `OBS_SCENE` | | 지정 시 녹화 전 이 장면으로 전환 |
| `RECORD_DIR` | | 로컬 저장 폴더 (기본 `./recordings`) |
| `MAX_RECORD_SEC` | | >0이면 그 초수에서 강제 종료(테스트). 운영은 비움 |
| `NTFY_TOPIC` | | ntfy 알림 토픽 (비우면 알림 끔) |
| `GDRIVE_ROOT` | ✔ | 드라이브 루트 폴더명. **없으면 `start`/`urls` 실행 거부** |
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

---

## 폴더 구조

```
video-recorder/
├─ .env                      # 설정(비밀값 포함, git 제외)
├─ data/catalogs/<이름>.json  # 종류별 작업 큐 [{id,title,url,skip?,done?}]
├─ recordings/               # 로컬 보관본 <제목>.mkv
├─ .userdata-msedge/         # Edge 프로필(네이버 로그인 세션, git 제외)
└─ src/
   ├─ index.js               # 진입점 (pnpm start)
   ├─ list.js                # pnpm urls
   ├─ orchestrator.js        # 지휘: 미완료 순회→녹화→업로드
   ├─ browser/               # session(로그인)·navigator·videoProbe(재생/신호)
   ├─ recorder/obsRecorder   # OBS 제어
   ├─ drive/                 # 구글 드라이브(OAuth+업로드)
   └─ core/                  # config·catalog·notify(ntfy)·logger

구글 드라이브:  내 드라이브 / <GDRIVE_ROOT> / <catalog> / <제목>.mkv
```

---

## 문제 해결

| 증상 | 원인·해결 |
|---|---|
| `GDRIVE_ROOT 미설정` | `.env`에 `GDRIVE_ROOT` 지정 |
| `구글 OAuth 자격증명 없음` | `.env`에 `GOOGLE_OAUTH_*` 3개 확인 |
| 시작 시 로그인 페이지가 뜸 | 네이버 세션 만료 → Edge 창에서 재로그인(“로그인 상태 유지”). ntfy로 🔐 알림도 옴 |
| OBS 녹화가 **검은 화면** | 윈도우 캡처를 `Windows Graphics Capture` + `REC-AUTOMATION`으로. 아니면 화면 캡처로 |
| 녹화에 **소리 없음/이중음** | 오디오 소스를 응용 프로그램 오디오 캡처 하나만. VB-CABLE 라우팅 확인 |
| 소리가 **스피커로 들림** | 볼륨 믹서에서 Edge 출력 = `CABLE Input` 인지 확인 |
| `urls` 제목이 "동영상"만 | 목록 페이지 구조가 다름 → 그 페이지 HTML 공유해 셀렉터 조정 |
| 알림이 안 옴 | `NTFY_TOPIC` 설정 + 폰 앱에서 같은 토픽 구독 확인 |

---

## 다른 PC/서버에서 돌리기

- **`.env`만 복사**하면 됨 (구글 OAuth·GDRIVE_ROOT·NTFY 모두 포함, 자체 완결). market-viewer 등 다른 프로젝트 불필요.
- 단, OBS 방식은 **화면이 실제로 그려지는 환경**(GUI + 오디오 장치)이 필요하다 — 헤드리스 서버엔 그대로 안 올라간다.
- 서버/무인 고려사항은 별도 논의 대상 (데이터센터 IP로 세션 쓰면 네이버가 민감할 수 있음 → 집 IP 권장).
