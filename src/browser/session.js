// 브라우저 세션 — 지속 컨텍스트 실행 + 네이버 로그인 상태 관리.
// 비밀번호는 절대 자동 입력하지 않는다. 최초 1회 사용자가 직접 로그인하고,
// 이후엔 .userdata 프로필에 저장된 세션을 재사용한다.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { config } from '../core/config.js';
import { log } from '../core/logger.js';

const execFileP = promisify(execFile);

// 자동화 프로필을 이미 물고 있는 브라우저 프로세스 찾기 (Windows 전용 — 다른 OS면 빈 배열).
// Chromium은 같은 user-data-dir 로 두 번째 인스턴스를 띄우면 기존 창에 위임하고 즉시 종료한다.
// 그러면 Playwright는 CDP 파이프를 잃고 "Target page, context or browser has been closed" 로 죽고,
// 더 나쁘게는 돌아가던 녹화 창에 빈 탭이 열려 제목이 바뀌며 OBS 윈도우 캡처가 끊긴다.
// → 띄우기 전에 미리 확인해서, 원인을 알 수 있는 메시지로 멈춘다.
async function findProfileHolders(userDataDir) {
  if (process.platform !== 'win32') return [];
  const ps = [
    "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' or Name='chrome.exe'\"",
    `| Where-Object { $_.CommandLine -like '*${userDataDir.replace(/'/g, "''")}*' }`,
    '| ForEach-Object { $_.ProcessId }',
  ].join(' ');
  try {
    const { stdout } = await execFileP('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 15000 });
    return stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (_) { return []; } // 조회 실패는 무시 — 가드일 뿐, 실행을 막을 이유는 아니다
}

async function ensureProfileFree(userDataDir) {
  const pids = await findProfileHolders(userDataDir);
  if (!pids.length) return;

  // --kill-browser 를 준 경우에만 정리한다. 진짜 녹화 중일 수도 있어 기본값은 '멈춤'.
  if (process.argv.includes('--kill-browser')) {
    log(`🧹 자동화 브라우저 ${pids.length}개 강제 종료 (--kill-browser)`);
    await execFileP('taskkill', ['/F', ...pids.flatMap((p) => ['/PID', p])]).catch(() => {});
    await new Promise((r) => setTimeout(r, 1500)); // 프로필 잠금 해제 대기
    return;
  }

  throw new Error(
    [
      `자동화 브라우저가 이미 실행 중입니다 (PID ${pids.join(', ')}).`,
      '',
      '  · 녹화(pnpm start)나 캡처(pnpm shot)가 돌고 있다면 → 끝난 뒤에 실행하세요.',
      '    지금 강행하면 돌아가던 녹화 창에 빈 탭이 열려 OBS 캡처가 끊깁니다.',
      '  · 아무것도 안 도는데 이 메시지가 뜨면(Ctrl+C 로 끊어 남은 유령 프로세스) → 같은 명령에',
      '    --kill-browser 를 붙여 다시 실행하세요.',
    ].join('\n'),
  );
}

// Edge 세션 복원 차단 — 직전 실행이 비정상 종료(크래시·강제 종료)되면 Edge가 지난 탭을 되살린다.
// 그러면 탭이 2개가 되어 창 제목이 "REC-AUTOMATION 외 페이지 1개"로 바뀌고,
// 제목 일치로 잠근 OBS 윈도우 캡처가 창을 놓친다(검은 화면). 복원할 거리를 아예 없애고 시작한다.
// 지우는 건 탭/세션 기록뿐 — 쿠키·로그인 세션은 다른 파일이라 영향 없다.
async function clearRestoreState(userDataDir) {
  const profile = path.join(userDataDir, 'Default');
  for (const d of ['Sessions', 'EdgeSessions']) {
    await fsp.rm(path.join(profile, d), { recursive: true, force: true }).catch(() => {});
  }
  // 크래시 표식도 정상 종료로 되돌린다 (복원 프롬프트/자동 복원 트리거)
  const prefPath = path.join(profile, 'Preferences');
  try {
    const pref = JSON.parse(await fsp.readFile(prefPath, 'utf-8'));
    if (pref.profile?.exit_type !== 'Normal' || pref.profile?.exited_cleanly !== true) {
      pref.profile = { ...pref.profile, exit_type: 'Normal', exited_cleanly: true };
      await fsp.writeFile(prefPath, JSON.stringify(pref));
    }
  } catch (_) {} // 프로필 최초 생성 등 — 없으면 그냥 넘어간다
}

// 수동 로그인 중에는 여분 탭 정리를 멈춘다 — 사용자가 직접 여는 창(팝업)을 닫아버리지 않도록.
let manualLogin = false;

// viewport: null(기본) = 창 크기를 그대로 씀(녹화용 — 전체화면이 곧 캡처 영역).
// viewport: {width,height} = 크기를 명시 고정(캡처용 — 모니터 해상도와 무관하게 결과물 폭 고정).
export async function launchSession({ headless = false, viewport = null } = {}) {
  await ensureProfileFree(config.userDataDir); // 같은 프로필을 쓰는 브라우저가 떠 있으면 여기서 멈춤
  await clearRestoreState(config.userDataDir); // 브라우저 뜨기 전에 — 지난 탭이 되살아나지 않도록
  const context = await chromium.launchPersistentContext(config.userDataDir, {
    headless,
    channel: config.browserChannel,
    viewport,
    chromiumSandbox: true, // 샌드박스 켜기 → "--no-sandbox 경고 바" 제거
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
      '--test-type', // "지원되지 않는 명령줄 플래그" 경고 바 제거
      // 뷰포트를 고정한 캡처 세션에서는 전체화면이 의미 없다(뷰포트가 창 크기를 무시하므로)
      ...(viewport ? [] : ['--start-fullscreen']), // 탭/주소창 없이 전체화면으로 시작
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

  // 안전망 — 그래도 살아남은 복원 탭은 닫는다. 자동화용 첫 탭만 남긴다.
  const main = context.pages()[0] || (await context.newPage());
  const closeExtra = async (p) => {
    if (p === main || manualLogin) return;
    await p.close().catch(() => {});
    log('🧹 여분 탭 정리 — 창 제목을 REC-AUTOMATION 하나로 유지');
  };
  for (const p of context.pages()) await closeExtra(p);
  // 복원 탭은 launchPersistentContext 반환보다 늦게 붙기도 하고, 녹화 중 사이트가 새 탭을
  // 띄우기도 한다 → 세션 내내 감시한다. 제목이 바뀌면 그 순간 OBS 캡처가 끊기므로.
  context.on('page', closeExtra);

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

  manualLogin = true; // 로그인 동안엔 여분 탭 정리 중단 (사용자가 연 창을 닫지 않도록)
  try {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await isLoggedIn(context)) { log('✅ 로그인 확인됨'); return; }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('로그인 대기 시간 초과');
  } finally {
    manualLogin = false;
  }
}
