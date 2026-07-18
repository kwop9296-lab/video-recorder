// 전역 설정 — .env + 고정 상수(셀렉터/타임아웃)를 한곳에 모은다.
import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// 자동화 브라우저 채널: 'chrome' | 'msedge'. Edge는 개인 크롬과 다른 앱이라 오디오 분리가 쉬움.
const browserChannel = process.env.BROWSER || 'chrome';

export const config = {
  root,
  browserChannel,
  // 브라우저별로 프로필(로그인 세션) 분리 — chrome↔edge 는 프로필 공유 불가
  userDataDir: path.join(root, browserChannel === 'chrome' ? '.userdata' : `.userdata-${browserChannel}`),
  recordDir: process.env.RECORD_DIR ? path.resolve(root, process.env.RECORD_DIR) : path.join(root, 'recordings'),

  headless: /^(1|true|yes)$/i.test(process.env.HEADLESS || ''), // 다운로더를 화면 없이 실행 (서버용)
  force: /^(1|true|yes)$/i.test(process.env.FORCE || ''), // 이미 완료된 것도 무시하고 재녹화

  // 자동화 창을 개인 크롬과 구분하기 위한 고정 제목 (OBS 윈도우 캡처에서 이걸로 잠금)
  windowTitle: 'REC-AUTOMATION',

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
    tailDelay: 1500,         // ended 후 정지까지 여유 (끝 짤림 방지)
  },
};
