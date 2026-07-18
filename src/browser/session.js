// 브라우저 세션 — 지속 컨텍스트 실행 + 네이버 로그인 상태 관리.
// 비밀번호는 절대 자동 입력하지 않는다. 최초 1회 사용자가 직접 로그인하고,
// 이후엔 .userdata 프로필에 저장된 세션을 재사용한다.

import { chromium } from 'playwright';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';

export async function launchSession({ headless = false } = {}) {
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless,
    channel: config.browserChannel,
    viewport: null,
    chromiumSandbox: true, // 샌드박스 켜기 → "--no-sandbox 경고 바" 제거
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--test-type', // "지원되지 않는 명령줄 플래그" 경고 바 제거
      '--start-fullscreen', // 탭/주소창 없이 전체화면으로 시작
      // 창이 가려져도(=앞에서 다른 작업) 계속 렌더/재생하도록 — WGC 백그라운드 캡처용
      '--disable-features=CalculateNativeWinOcclusion',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
    ],
  });

  // 창 제목을 고정 → OBS 윈도우 캡처가 이 창만 정확히 잠금 (개인 크롬과 구분)
  await context.addInitScript((title) => {
    const pin = () => { try { if (document.title !== title) document.title = title; } catch (_) {} };
    pin();
    setInterval(pin, 500);
  }, config.windowTitle);

  return context;
}

// NID_AUT / NID_SES 쿠키로 로그인 여부 판정 (DOM 비의존, 신뢰도 높음)
export async function isLoggedIn(context) {
  const cookies = await context.cookies('https://www.naver.com');
  return cookies.some((c) => c.name === 'NID_AUT') && cookies.some((c) => c.name === 'NID_SES');
}

// 로그인 안돼있으면 로그인 페이지를 열고 사용자가 직접 로그인할 때까지 대기.
export async function ensureLoggedIn(context, { timeout = 300000 } = {}) {
  if (await isLoggedIn(context)) { log('🔐 로그인 상태 확인됨 (세션 재사용)'); return; }

  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://nid.naver.com/nidlogin.login').catch(() => {});
  log('⚠ 네이버 로그인이 필요합니다 → 열린 창에서 직접 로그인하세요 ("로그인 상태 유지" 체크 권장)');

  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await isLoggedIn(context)) { log('✅ 로그인 확인됨'); return; }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error('로그인 대기 시간 초과');
}
