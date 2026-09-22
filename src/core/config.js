// 전역 설정 — .env + 고정 상수(셀렉터/타임아웃)를 한곳에 모은다.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 자동화 브라우저 채널: 'chrome' | 'msedge'. Edge는 개인 크롬과 다른 앱이라 오디오 분리가 쉬움.
const browserChannel = process.env.BROWSER || 'chrome';

// 브라우저별로 프로필(로그인 세션) 분리 — chrome↔edge 는 프로필 공유 불가
const profileBase = browserChannel === 'chrome' ? '.userdata' : `.userdata-${browserChannel}`;

// 계정(같은 사이트의 두 번째 아이디) 꼬리표. 폴더·창 제목에 붙으므로 안전한 문자만 남긴다.
// 빈 문자열 = 기본 계정 (기존 경로/제목 그대로).
export const normalizeAccount = (a) =>
  String(a || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);

const suffixes = (siteId, account) => [siteId && siteId !== 'naver' ? siteId : '', normalizeAccount(account)].filter(Boolean);

export const config = {
  root,
  browserChannel,
  userDataDir: path.join(root, profileBase), // 기본(네이버, 기본계정) 프로필
  // 사이트·계정별 프로필 분리 — 네이버 녹화와 나인뷰 캡처를, 또 같은 사이트의 두 아이디를
  // 한 PC에서 동시에 돌릴 수 있게. 네이버 기본계정은 기존 경로 그대로라 재로그인이 필요 없다.
  //   naver/기본 → .userdata-msedge        najuda/기본 → .userdata-msedge-najuda
  //   naver/sub  → .userdata-msedge-sub    najuda/sub  → .userdata-msedge-najuda-sub
  userDataDirFor: (siteId, account = '') => path.join(root, [profileBase, ...suffixes(siteId, account)].join('-')),
  recordDir: process.env.RECORD_DIR ? path.resolve(root, process.env.RECORD_DIR) : path.join(root, 'recordings'),
  captureDir: process.env.CAPTURE_DIR ? path.resolve(root, process.env.CAPTURE_DIR) : path.join(root, 'captures'),

  headless: /^(1|true|yes)$/i.test(process.env.HEADLESS || ''), // 다운로더를 화면 없이 실행 (서버용)
  force: /^(1|true|yes)$/i.test(process.env.FORCE || ''), // 이미 완료된 것도 무시하고 재녹화

  // 자동화 창을 개인 크롬과 구분하기 위한 고정 제목 (OBS 윈도우 캡처에서 이걸로 잠금)
  windowTitle: 'REC-AUTOMATION',
  // 사이트·계정별 창 제목 — 여럿을 동시에 돌려도 OBS가 엉뚱한 창을 잡지 않게.
  // 네이버 기본계정은 기존 제목 그대로 (OBS 소스 재설정 불필요).
  windowTitleFor: (siteId, account = '') => ['REC-AUTOMATION', ...suffixes(siteId, account)].join('-').toUpperCase(),

  obs: {
    url: process.env.OBS_WS_URL || 'ws://127.0.0.1:4455',
    password: process.env.OBS_WS_PASSWORD || '',
    scene: process.env.OBS_SCENE || '', // 지정 시 녹화 전 이 장면으로 전환
  },

  // 구글 드라이브 — 완료된 녹화의 최종 저장소이자 "완료 판정"의 기준.
  drive: {
    rootFolder: process.env.GDRIVE_ROOT || '', // 필수(없으면 start/urls 에서 실행 거부). 이 아래 catalog별 하위폴더.
  },

  // ntfy 푸시 알림 (topic 비우면 알림 끔)
  ntfy: {
    server: process.env.NTFY_URL || 'https://ntfy.sh',
    topic: process.env.NTFY_TOPIC || '',
  },

  quality: '1080p',

  // 페이지 캡처(pnpm shot) — 녹화와 완전히 별개 경로. OBS/영상 제어를 쓰지 않는다.
  capture: {
    // 뷰포트를 명시 고정 → PC 모니터 해상도와 무관하게 결과물 폭이 항상 같다(두 PC 분담 시 중요).
    viewport: { width: 1440, height: 900 },
    maxPageHeight: 16000, // 이 높이를 넘으면 Chromium 한계로 한 장 캡처가 잘림 → 자동 분할
    splitChunk: 8000,     // 분할 시 한 장의 높이
    scrollRatio: 0.9,     // lazy 로딩 유발용 스크롤 보폭 (뷰포트 대비)
    scrollDelay: 350,     // 스크롤 한 칸마다 대기
    maxScrollLoops: 400,  // 무한 스크롤 안전장치
    settleDelay: 800,     // 맨 위 복귀 후 안정화 대기
    stitch: true,         // 분할된 조각을 다시 세로로 이어붙여 '긴 한 장'으로 만든다
    stitchMaxHeight: 60000, // 이 높이를 넘으면 이어붙이지 않고 조각 그대로 둔다(메모리/뷰어 한계)
  },

  // 테스트용: >0 이면 영상이 안 끝나도 이 초수에서 녹화 강제 종료 (예: 60)
  maxRecordSec: process.env.MAX_RECORD_SEC ? Number(process.env.MAX_RECORD_SEC) : 0,

  // 네이버 PrismPlayer(pzp) 셀렉터 — 스파이크로 확인됨
  selectors: {
    video: 'video.webplayer-internal-video',
    settingsButton: 'button.pzp-setting-button',
    qualityHome: '.pzp-setting-intro-quality',
    qualityItem: 'li.pzp-ui-setting-quality-item',
    fullscreenButton: 'button.pzp-fullscreen-button',
  },

  timeouts: {
    playerAppear: 30000,     // 페이지 이동 후 video 등장 대기
    playStart: 12000,        // 클릭 후 재생 시작 확인
    quality: 15000,          // 1080p 반영 대기
    endWatchdogMargin: 180000, // ended 안 오면 duration+3분 후 강제 종료
    obsStartConfirm: 8000,   // OBS 녹화 active 확인 최대 대기 (안전마진)
    tailDelay: 5000,         // ended 후 정지까지 여유 (끝 짤림 방지)
    pageSettle: 15000,       // 캡처: 이동 후 networkidle 대기 (안 와도 그냥 진행)
    imageLoad: 10000,        // 캡처: 남은 이미지 디코드 대기 상한
  },
};
