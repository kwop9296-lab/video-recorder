// 콘텐츠 페이지로 이동하고 플레이어(video)가 뜬 프레임을 돌려준다.
// 오케스트레이터가 page.goto로 직접 이동하므로 새 탭이 아니라 같은 탭에서 진행된다.

import { log } from '../core/logger.js';

export async function openContent(page, url, { selector, timeout, requireVideo = true }) {
  log('  🌐 이동:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  const frame = await waitForVideoFrame(page, selector, timeout);
  if (!frame && requireVideo) throw new Error(`플레이어(${selector}) 등장 대기 초과`);
  return frame; // 영상 없으면 null (requireVideo:false 일 때)
}

// 콘텐츠의 실제 제목을 읽는다. document.title 은 REC-AUTOMATION 으로 고정돼 있으므로
// 손대지 않은 og:title 메타태그를 우선 사용한다.
export async function getContentTitle(frame) {
  return frame.evaluate(() => {
    const meta = (s) => document.querySelector(s)?.getAttribute('content') || '';
    const text = (s) => document.querySelector(s)?.textContent || '';
    const t = meta('meta[property="og:title"]') || meta('meta[name="title"]') || text('h1') || text('h2');
    return (t || '').replace(/\s+/g, ' ').trim();
  }).catch(() => '');
}

async function waitForVideoFrame(page, selector, timeout) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    for (const f of page.frames()) {
      try { if (await f.evaluate((s) => !!document.querySelector(s), selector)) return f; } catch (_) {}
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}
