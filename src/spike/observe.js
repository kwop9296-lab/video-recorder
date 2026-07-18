// 스파이크: 대상 플레이어(video.webplayer-internal-video)의 재생/종료 신호를 "관찰"만 하는 스크립트.
// 목적 — 아래를 눈으로 확인해서 프로브(videoProbe) 설계를 확정한다.
//   1) video.play() / pause() 로 직접 제어가 되는가? (아니면 재생버튼 클릭 필요)
//   2) 로드 시 자동재생인가, 클릭이 필요한가?
//   3) 종료 시 'ended' 가 깨끗하게 오는가? (광고/요소 교체는 없는가)
//   4) duration / readyState / buffered 가 정상적으로 읽히는가?
//
// 실행:  pnpm spike            (TARGET_URL 없으면 naver.com)
//        pnpm spike <url>      (URL 직접 지정 — 실제 영상 콘텐츠 페이지 권장)
//
// 명령:  p(play) s(pause) 0(seek0) i(info) l(로그인쿠키확인) f(프레임별 video수) q(종료)

import 'dotenv/config';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const USER_DATA_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.userdata');
const TARGET_URL = process.argv[2] || process.env.TARGET_URL || 'https://www.naver.com';
const TARGET_SELECTOR = 'video.webplayer-internal-video';

const start = Date.now();
const ts = () => `+${((Date.now() - start) / 1000).toFixed(2)}s`;
const log = (...a) => console.log(ts().padStart(9), ...a);

// ─────────────────────────────────────────────────────────────
// 브라우저(모든 프레임) 안에서 실행. 대상 클래스 video 에만 리스너를 붙이고
// 정규화 이벤트를 window.__probe(...) 로 전달. 광고 등 그 외 video 는 1회만 '무시' 보고.
// DOM 미준비/iframe 에서도 절대 throw 하지 않도록 방어.
// ─────────────────────────────────────────────────────────────
function installProbe(targetSelector) {
  if (window.__probeInstalled) return;
  window.__probeInstalled = true;
  try {
    const send = (p) => { try { window.__probe(p); } catch (_) {} };
    const EVENTS = [
      'loadedmetadata', 'loadeddata', 'canplay', 'play', 'playing',
      'pause', 'waiting', 'stalled', 'seeking', 'seeked',
      'ratechange', 'durationchange', 'ended', 'emptied', 'abort', 'error',
    ];
    const attached = new WeakSet();
    const ignored = new WeakSet();
    let seq = 0;
    let tick = null;

    const snap = (v) => {
      let bufEnd = null;
      try { if (v.buffered && v.buffered.length) bufEnd = +v.buffered.end(v.buffered.length - 1).toFixed(2); } catch (_) {}
      return {
        t: +(v.currentTime || 0).toFixed(2),
        dur: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null,
        paused: v.paused, ended: v.ended, readyState: v.readyState,
        muted: v.muted, err: v.error ? v.error.code : null, bufEnd,
      };
    };

    const startTick = () => {
      if (tick) return;
      tick = setInterval(() => {
        const v = document.querySelector(targetSelector);
        if (v) send({ kind: 'tick', idx: v.__probeIdx ?? -1, ...snap(v) });
      }, 2000);
    };

    const attach = (v) => {
      if (attached.has(v)) return;
      attached.add(v);
      const idx = seq++;
      v.__probeIdx = idx;
      send({
        kind: 'attach', idx, cls: v.className,
        frame: window.top === window ? 'top' : 'iframe', host: location.host,
        currentSrc: (v.currentSrc || '').slice(0, 80), ...snap(v),
      });
      EVENTS.forEach((type) =>
        v.addEventListener(type, () => send({ kind: 'event', type, idx, host: location.host, ...snap(v) })),
      );
      startTick();
    };

    const scan = () => {
      try {
        document.querySelectorAll('video').forEach((v) => {
          if (v.matches(targetSelector)) attach(v);
          else if (!ignored.has(v)) { ignored.add(v); send({ kind: 'ignore', cls: v.className, host: location.host }); }
        });
      } catch (_) {}
    };
    const root = document.documentElement || document; // document-start 시 <html> 미존재 대비
    scan();
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  } catch (_) { /* 프레임 DOM 미준비 → 무시 */ }
}

const fmt = (p) => {
  const bits = [];
  if (p.idx !== undefined) bits.push(`#${p.idx}`);
  if (p.host) bits.push(`@${p.host}`);
  if (p.t !== undefined) bits.push(`t=${p.t}`);
  if (p.dur !== undefined) bits.push(`dur=${p.dur}`);
  if (p.paused !== undefined) bits.push(`paused=${p.paused}`);
  if (p.ended) bits.push('ENDED');
  if (p.readyState !== undefined) bits.push(`ready=${p.readyState}`);
  if (p.bufEnd != null) bits.push(`buf=${p.bufEnd}`);
  if (p.err != null) bits.push(`ERR=${p.err}`);
  return bits.join(' ');
};

// 컨텍스트의 모든 탭·프레임을 훑어 대상 video 가 있는 프레임 반환 (콘텐츠가 새 탭일 수 있음)
async function findVideoFrame(context) {
  for (const page of context.pages()) {
    for (const f of page.frames()) {
      try { if (await f.evaluate((s) => !!document.querySelector(s), TARGET_SELECTOR)) return f; } catch (_) {}
    }
  }
  for (const page of context.pages()) {
    for (const f of page.frames()) {
      try { if (await f.evaluate(() => !!document.querySelector('video'))) return f; } catch (_) {}
    }
  }
  return null;
}

async function checkLogin(context) {
  const cookies = await context.cookies('https://www.naver.com');
  const aut = cookies.find((c) => c.name === 'NID_AUT');
  const ses = cookies.find((c) => c.name === 'NID_SES');
  if (!aut || !ses) return '❌ 로그아웃 상태 (NID_AUT/NID_SES 없음)';
  // expires: -1 이면 세션 쿠키(브라우저 종료 시 소멸) → 재시작 후 로그인 풀림
  const persistent = typeof aut.expires === 'number' && aut.expires > 0;
  return persistent
    ? '✅ 로그인됨 + 영구쿠키 (재시작해도 유지)'
    : '⚠ 로그인됨 but 세션쿠키 (브라우저 끄면 풀림 → 로그인 시 "로그인 상태 유지" 체크 필요)';
}

async function main() {
  log('브라우저(실제 Chrome) 실행...');
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false,
    channel: 'chrome',
    viewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  await context.exposeBinding('__probe', (_src, p) => {
    if (p.kind === 'attach') log('🎯 대상 video 발견', `#${p.idx}`, `[${p.frame}@${p.host}]`, `cls="${p.cls}"`, `src=${p.currentSrc || '(none)'}`, fmt(p));
    else if (p.kind === 'event') log('▶', p.type.padEnd(14), fmt(p));
    else if (p.kind === 'tick') log('·', fmt(p));
    else if (p.kind === 'ignore') log('  (무시: 대상 아님)', `cls="${p.cls}"`, `@${p.host}`);
  });
  await context.addInitScript(installProbe, TARGET_SELECTOR); // 이후 페이지/프레임에도 자동 주입

  // 모든 탭(기존+새로 열리는)에 로깅 리스너 부착
  const wire = (page, tag) => {
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) log(`🌐 [${tag}] 이동:`, f.url()); });
    page.on('pageerror', (e) => log(`⚠ [${tag}] pageerror:`, e.message));
  };
  context.on('page', (p) => { log('🆕 새 탭 열림'); wire(p, 'tab' + context.pages().length); });

  const page = context.pages()[0] || (await context.newPage());
  wire(page, 'tab1');

  log('접속:', TARGET_URL);
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded' }).catch((e) => log('goto 경고:', e.message));
  await page.evaluate(installProbe, TARGET_SELECTOR).catch(() => {});
  log('🔐 로그인 상태:', await checkLogin(context));

  printHelp();
  attachCommands(context);
}

function printHelp() {
  console.log(`
─────────────────────────────────────────────
 관찰 모드. 순서:
   1) 콘텐츠 페이지 이동 → c(클릭재생)
   2) hd(1080p 설정) → i 로 vw×vh 가 1920x1080 되는지 확인
   3) fs(전체화면) → i 로 fs=true 확인
   4) e(끝으로) 로 ended 확인

 재생: c(클릭재생) p(play) s(pause) 0(seek0) e(끝으로)
 화질/화면: hd(1080p) fs(전체화면)
 탐색: h(hover) d(컨트롤나열) x N(N번/셀렉터 클릭)
 기타: i(info) l(로그인) f(탭video) q(종료)
─────────────────────────────────────────────`);
}

function attachCommands(context) {
  const rl = readline.createInterface({ input: process.stdin });
  const onVideo = async (fn, label) => {
    const f = await findVideoFrame(context);
    if (!f) { log(`↳ ${label}: video 없음 (모든 탭/프레임 탐색함)`); return; }
    try { log(`↳ ${label}:`, await f.evaluate(fn, TARGET_SELECTOR)); }
    catch (e) { log(`↳ ${label} 실패:`, e.message); }
  };
  rl.on('line', async (line) => {
    const raw = line.trim();
    const c = raw.toLowerCase();
    if (c === 'p') await onVideo((s) => { const v = (document.querySelector(s) || document.querySelector('video')); v.play(); return 'play() 호출됨, paused=' + v.paused; }, 'play');
    else if (c === 's') await onVideo((s) => { const v = (document.querySelector(s) || document.querySelector('video')); v.pause(); return 'pause() 호출됨, paused=' + v.paused; }, 'pause');
    else if (c === '0') await onVideo((s) => { const v = (document.querySelector(s) || document.querySelector('video')); v.currentTime = 0; return 'currentTime=' + v.currentTime; }, 'seek0');
    else if (c === 'i') await onVideo((s) => { const v = (document.querySelector(s) || document.querySelector('video')); return { t: v.currentTime, dur: v.duration, paused: v.paused, ended: v.ended, ready: v.readyState, muted: v.muted, vw: v.videoWidth, vh: v.videoHeight, fs: !!document.fullscreenElement }; }, 'info');
    else if (c === 'e') await onVideo((s) => { const v = (document.querySelector(s) || document.querySelector('video')); if (!v.duration || !isFinite(v.duration)) return 'duration 아직 없음(재생 먼저)'; v.currentTime = Math.max(0, v.duration - 5); return 'seek→' + v.currentTime.toFixed(1) + ' (ended 테스트)'; }, 'seekEnd');
    else if (c === 'c') {
      const f = await findVideoFrame(context);
      if (!f) { log('↳ click: video 프레임 없음'); return; }
      try {
        const box = await f.locator(TARGET_SELECTOR).first().boundingBox({ timeout: 3000 });
        if (!box) { log('↳ click: boundingBox 없음(요소 미표시)'); return; }
        await f.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        log(`↳ click: 플레이어 중앙(${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)}) 트러스티드 클릭 완료`);
      } catch (e) { log('↳ click 실패:', e.message); }
    }
    else if (c === 'h') { // 플레이어 위로 마우스 이동 → 숨은 컨트롤바 표시 유도
      const f = await findVideoFrame(context);
      const box = f && await f.locator(TARGET_SELECTOR).first().boundingBox({ timeout: 2000 }).catch(() => null);
      if (!box) { log('↳ hover: video bbox 없음'); return; }
      await f.page().mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      log('↳ hover: 플레이어 중앙으로 마우스 이동');
    }
    else if (c === 'd') { // 플레이어 컨트롤 후보 나열 + data-spike 번호 부여
      const f = await findVideoFrame(context);
      if (!f) { log('↳ dump: 프레임 없음'); return; }
      const items = await f.evaluate(() => {
        const cand = Array.from(document.querySelectorAll(
          'button,[role="button"],[aria-label],[title],[class*="webplayer"],[class*="control"],[class*="setting"],[class*="quality"],[class*="fullscreen"],[class*="full-screen"],li,[role="menuitem"]'));
        const out = []; let i = 0;
        for (const el of cand) {
          if (el.tagName === 'VIDEO') continue;
          el.setAttribute('data-spike', i);
          out.push({
            i, tag: el.tagName.toLowerCase(),
            cls: (el.className && el.className.toString().slice(0, 55)) || '',
            aria: el.getAttribute('aria-label') || '', title: el.getAttribute('title') || '',
            text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 24),
            vis: !!(el.offsetParent || el.getClientRects().length),
          });
          if (++i > 150) break;
        }
        return out;
      });
      const interesting = items.filter((it) => it.aria || it.title || it.text || /webplayer|control|setting|quality|full|screen/i.test(it.cls));
      log(`↳ dump: 후보 ${items.length}개 중 관심 ${interesting.length}개 (● 표시됨 / ○ 숨김)`);
      for (const it of interesting) log(`   [${it.i}] ${it.vis ? '●' : '○'} ${it.tag} cls="${it.cls}" aria="${it.aria}" title="${it.title}" txt="${it.text}"`);
    }
    else if (c.startsWith('x ')) { // data-spike 번호 또는 CSS 셀렉터를 트러스티드 클릭
      const arg = raw.slice(2).trim();
      const sel = /^\d+$/.test(arg) ? `[data-spike="${arg}"]` : arg;
      const f = await findVideoFrame(context);
      if (!f) { log('↳ x: 프레임 없음'); return; }
      try {
        const box = await f.locator(sel).first().boundingBox({ timeout: 2000 });
        if (!box) { log('↳ x: 요소 안보임', sel); return; }
        await f.page().mouse.click(box.x + box.width / 2, box.y + box.height / 2);
        log(`↳ x: 클릭 ${sel} (${Math.round(box.x + box.width / 2)},${Math.round(box.y + box.height / 2)})`);
      } catch (e) { log('↳ x 실패:', e.message); }
    }
    else if (c === 'hd') { // 화질 1080p 설정 시퀀스 (PrismPlayer: 톱니 → 해상도 → 1080p)
      const f = await findVideoFrame(context);
      if (!f) { log('↳ hd: 프레임 없음'); return; }
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      try {
        const vbox = await f.locator(TARGET_SELECTOR).first().boundingBox().catch(() => null);
        if (vbox) await f.page().mouse.move(vbox.x + vbox.width / 2, vbox.y + vbox.height / 2); // 컨트롤 표시
        await f.locator('button.pzp-setting-button').first().click({ timeout: 3000 });
        await sleep(350);
        await f.locator('.pzp-setting-intro-quality').first().click({ timeout: 3000 });
        await sleep(350);
        await f.locator('li.pzp-ui-setting-quality-item', { hasText: '1080p' }).first().click({ timeout: 3000 });
        log('↳ hd: 1080p 선택 완료 (재버퍼링 tick 확인)');
      } catch (e) { log('↳ hd 실패:', e.message); }
    }
    else if (c === 'fs') { // 전체화면 토글
      const f = await findVideoFrame(context);
      if (!f) { log('↳ fs: 프레임 없음'); return; }
      try { await f.locator('button.pzp-fullscreen-button').first().click({ timeout: 3000 }); log('↳ fs: 전체화면 버튼 클릭'); }
      catch (e) { log('↳ fs 실패:', e.message); }
    }
    else if (c === 'l') log('🔐 로그인 상태:', await checkLogin(context));
    else if (c === 'f') {
      const pages = context.pages();
      for (let i = 0; i < pages.length; i++) {
        log(`  [tab${i + 1}] ${pages[i].url().slice(0, 70)}`);
        for (const fr of pages[i].frames()) {
          try {
            const n = await fr.evaluate(() => document.querySelectorAll('video').length);
            if (n) log(`     frame videos=${n}`, fr.url().slice(0, 66));
          } catch (_) {}
        }
      }
    } else if (c === 'q') { log('종료'); process.exit(0); }
    else if (c) log('알 수 없는 명령:', c, '(c/p/s/0/e/hd/fs/h/d/x/i/l/f/q)');
  });
}

main().catch((e) => { console.error(e); process.exit(1); });
