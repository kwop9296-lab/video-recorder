// 사이트 어댑터 — 네이버 프리미엄콘텐츠.
// 원래 list.js / session.js 안에 있던 네이버 전용 로직을 그대로 옮긴 것이다(동작 변화 없음).

import { log } from '../core/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const RE = /\/contents\/[0-9A-Za-z]{8,}$/;
const isPlaceholder = (t) => !t || /^(동영상|재생|재생하기|이미지|썸네일)$/.test(t);

export default {
  id: 'naver',
  label: '네이버',
  matchHost: (h) => /(^|\.)naver\.com$/.test(h),
  loginUrl: 'https://nid.naver.com/nidlogin.login',
  loginHint: '열린 창에서 직접 로그인하세요 ("로그인 상태 유지" 체크 권장)',
  loginUrlFor() { return this.loginUrl; }, // 네이버는 로그인 후 알아서 돌아온다 — 기존 흐름 유지

  // URL 끝의 콘텐츠 ID (쿼리 붙어도 안전)
  contentId(url) {
    try { return new URL(url).pathname.split('/').filter(Boolean).pop() || url; }
    catch (_) { return url; }
  },

  // NID_AUT / NID_SES 쿠키로 판정 (DOM 비의존, 신뢰도 높음)
  async isLoggedIn(context) {
    const cookies = await context.cookies('https://www.naver.com');
    return cookies.some((c) => c.name === 'NID_AUT') && cookies.some((c) => c.name === 'NID_SES');
  },

  // 카테고리 목록 페이지를 끝까지 스크롤하며 (제목+URL) 수집 → [{ id, title, url }]
  async collectList(page, listUrl) {
    const found = new Map(); // url -> title

    const collect = async () => {
      const items = await page.evaluate(() => {
        const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
        let cards = [...document.querySelectorAll('.content_item_inner')].map((card) => {
          const a = card.querySelector('a[href*="/contents/"]');
          const t = card.querySelector('.content_title') || card.querySelector('strong, h2, h3, h4, [class*="title" i]');
          return a ? { url: a.href.split(/[?#]/)[0], title: clean(t && t.textContent).slice(0, 120) } : null;
        }).filter(Boolean);
        if (!cards.length) {
          cards = [...document.querySelectorAll('a[href*="/contents/"]')].map((a) => {
            const t = a.querySelector('.content_title, strong, h3');
            return { url: a.href.split(/[?#]/)[0], title: clean(t && t.textContent).slice(0, 120) };
          });
        }
        return cards;
      });
      for (const it of items) {
        if (!RE.test(it.url)) continue;
        const prev = found.get(it.url);
        if (!found.has(it.url) || (isPlaceholder(prev) && !isPlaceholder(it.title))) found.set(it.url, it.title);
      }
    };

    log('🌐 목록 이동:', listUrl);
    await page.goto(listUrl, { waitUntil: 'domcontentloaded' });
    log('목록 로딩(끝까지 스크롤하며 수집)...');
    await sleep(1500);
    for (let k = 0; k < 3; k++) { await collect(); await sleep(500); }

    let stable = 0;
    for (let i = 0; i < 500 && stable < 5; i++) {
      const before = found.size;
      await collect();
      await page.evaluate(() => {
        const el = document.scrollingElement || document.documentElement;
        el.scrollBy(0, Math.round(el.clientHeight * 0.9));
      }).catch(() => {});
      await sleep(900);
      await collect();
      stable = found.size === before ? stable + 1 : 0;
      if (i % 10 === 0) log(`  ...누적 ${found.size}개`);
    }

    return [...found].map(([url, title]) => ({ id: this.contentId(url), title: title || this.contentId(url), url }));
  },
};
