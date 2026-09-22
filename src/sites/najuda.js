// 사이트 어댑터 — 나주다 인사이트 뷰(나인뷰, najuda.com).
//
// 네이버와 다른 점 세 가지:
//  1) 목록이 서버 렌더 한 방 — 무한스크롤이 없다. (숨은 페이지네이션 대비로 ?page= 만 조심스레 따라간다)
//  2) 콘텐츠 URL이 전부 같은 경로(content_view.php)라 ID를 경로가 아닌 board_id+no 로 만든다.
//  3) /nineview/ 와 /nainview/ 가 같은 페이지다 → 반드시 한쪽으로 정규화해야 같은 글이 두 개로 안 잡힌다.

import { log } from '../core/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ORIGIN = 'https://najuda.com';
const BASE = `${ORIGIN}/nainview/`;
const MAX_PAGES = 50; // ?page= 를 따라갈 상한 (서버가 무시하면 2페이지째에 멈춘다)

// 비로그인 상태의 목록은 링크가 login.php?redirect=<진짜주소> 로 감싸여 있다 → 벗겨낸다.
function unwrapLogin(href) {
  let u;
  try { u = new URL(href, BASE); } catch (_) { return null; }
  for (let i = 0; i < 3 && /\/login\.php$/i.test(u.pathname); i++) {
    const r = u.searchParams.get('redirect');
    if (!r) break;
    try { u = new URL(r, BASE); } catch (_) { return null; }
  }
  return u;
}

// 콘텐츠 URL 정규화 — 경로(/nineview|/nainview)와 부가 파라미터(ctx 등)를 털어낸 표준형.
// 콘텐츠 링크가 아니면 null.
export function canonicalUrl(href) {
  const u = unwrapLogin(href);
  if (!u || !/content_view\.php$/i.test(u.pathname)) return null;
  const board = u.searchParams.get('board_id');
  const no = u.searchParams.get('no');
  const post = u.searchParams.get('post_id');
  if (board && no) return `${BASE}content_view.php?board_id=${encodeURIComponent(board)}&no=${encodeURIComponent(no)}`;
  if (post) return `${BASE}content_view.php?post_id=${encodeURIComponent(post)}`;
  return null;
}

export default {
  id: 'najuda',
  label: '나인뷰',
  matchHost: (h) => /(^|\.)najuda\.com$/.test(h),
  loginUrl: `${BASE}login.php`,
  loginHint: '열린 창에서 나인뷰 아이디/비밀번호로 직접 로그인하세요',

  // 로그인 후 돌아올 곳을 지정 — 사이트 자체도 login.php?redirect=<경로> 형태를 쓴다.
  // (파라미터 없이 열어도 폼의 기본값이 홈이라 로그인은 되지만, 그러면 목표 페이지로 못 돌아온다)
  loginUrlFor(returnTo) {
    if (!returnTo) return this.loginUrl;
    try {
      const u = new URL(returnTo, BASE);
      if (!this.matchHost(u.hostname.toLowerCase())) return this.loginUrl; // 남의 사이트 주소는 무시
      return `${this.loginUrl}?redirect=${encodeURIComponent(u.pathname + u.search)}`;
    } catch (_) { return this.loginUrl; }
  },

  // board_id+no → 'b38-n12' / post_id → 'p-guide'. 경로가 달라도 같은 글이면 같은 ID.
  contentId(url) {
    const c = canonicalUrl(url) || url;
    try {
      const q = new URL(c, BASE).searchParams;
      const board = q.get('board_id');
      const no = q.get('no');
      if (board && no) return `b${board}-n${no}`;
      const post = q.get('post_id');
      if (post) return `p-${post}`;
    } catch (_) {}
    return String(url);
  },

  // PHP 세션이라 쿠키 이름만으론 판정이 안 된다(비로그인도 세션 쿠키를 받음).
  // 컨텍스트의 쿠키를 그대로 쓰는 request 로 홈을 한 번 긁어 "로그인 링크가 남아있는지"로 본다.
  async isLoggedIn(context) {
    try {
      const res = await context.request.get(BASE, { timeout: 20000, failOnStatusCode: false });
      if (/\/login\.php/i.test(res.url())) return false; // 로그인 페이지로 튕김
      const html = await res.text();
      if (/logout\.php|로그아웃/i.test(html)) return true;
      return !/login\.php(\?|")/i.test(html);
    } catch (_) {
      return false; // 네트워크 실패는 "모름" → 로그인 대기로 보내는 편이 안전
    }
  },

  // 글 페이지가 실제로 열렸는지 확인 — 세션 만료(login.php)나 권한 없음(school_only)이면
  // 안내 화면이 뜨는데, 그걸 그대로 캡처해 올리면 '완료'로 굳어버린다. 차라리 실패로 남긴다.
  assertAccessible(page) {
    const u = page.url();
    if (/\/login\.php/i.test(u)) throw new Error('로그인 세션 만료 — pnpm signin najuda 로 다시 로그인하세요');
    if (/school_only=1/i.test(u)) throw new Error('접근 권한 없음(스쿨 수강생 전용)');
  },

  // 코스 탭 페이지에서 글 목록 수집 → [{ id, title, url }] (사이트 노출 순서 = 최신이 위)
  async collectList(page, listUrl) {
    const found = new Map(); // id -> { url, title }
    let prevSig = '';

    for (let p = 1; p <= MAX_PAGES; p++) {
      const url = p === 1 ? listUrl : withParam(listUrl, 'page', p);
      log(p === 1 ? `🌐 목록 이동: ${url}` : `  ...${p}페이지`);
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('.nv-post-row, .nv-content-list, a[href*="content_view.php"]', { timeout: 15000 }).catch(() => {});
      await sleep(400);

      const rows = await page.evaluate(scrapeRows);
      if (!rows.length) break;

      // 서버가 ?page= 를 무시하면 1페이지와 똑같은 목록이 온다 → 거기서 멈춘다.
      const sig = rows.map((r) => r.href).join('|');
      if (sig === prevSig) break;
      prevSig = sig;

      let added = 0;
      for (const r of rows) {
        const u = canonicalUrl(r.href);
        if (!u) continue;
        const id = this.contentId(u);
        if (found.has(id)) continue;
        found.set(id, { url: u, title: r.title || id });
        added++;
      }
      log(`  ...누적 ${found.size}개`);
      if (!added) break; // 새 글이 하나도 없으면 더 볼 이유가 없다
    }

    return [...found].map(([id, v]) => ({ id, title: v.title, url: v.url }));
  },
};

// 목록 DOM 긁기 (브라우저 안에서 실행 — 여기선 Node 헬퍼를 못 쓴다)
function scrapeRows() {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const strip = (s) => clean(s).replace(/^[\u{1F512}\u{1F513}\s]+/u, ''); // 앞머리 자물쇠(🔒/🔓) 제거

  const rows = [...document.querySelectorAll('.nv-content-list .nv-post-row')].map((el) => {
    const a = el.matches('a[href]') ? el : el.querySelector('a[href]') || el.closest('a[href]');
    if (!a) return null;
    const t = el.querySelector('.nv-post-row__title') || el.querySelector('[class*="title" i]');
    return { href: a.href, title: strip(t ? t.textContent : a.textContent).slice(0, 120) };
  }).filter(Boolean);
  if (rows.length) return rows;

  // 폴백 — 클래스명이 바뀌었을 때도 최소한 링크는 건진다(고정글·공지 포함).
  return [...document.querySelectorAll('a[href*="content_view.php"]')].map((a) => {
    const t = a.querySelector('[class*="title" i]');
    return { href: a.href, title: strip(t ? t.textContent : a.textContent).slice(0, 120) };
  });
}

function withParam(url, key, value) {
  try {
    const u = new URL(url, BASE);
    u.searchParams.set(key, String(value));
    return u.href;
  } catch (_) { return url; }
}
