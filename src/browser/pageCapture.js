// 페이지를 끝까지 훑어 lazy 콘텐츠를 모두 불러온 뒤 PNG로 캡처한다.
// 기본은 전체페이지 한 장. 문서가 Chromium 한 장 한계(약 16000px)를 넘으면 화면 단위로 자동 분할한다.

import { config } from '../core/config.js';
import { log } from '../core/logger.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 이동 + 로딩 안정화. networkidle 은 안 올 수도 있으므로 실패해도 그냥 진행한다.
export async function openPage(page, url) {
  log('  🌐 이동:', url);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  await page.waitForLoadState('networkidle', { timeout: config.timeouts.pageSettle }).catch(() => {});
}

// destBase = 확장자 없는 경로. 반환: 실제로 저장된 파일 경로 배열.
export async function capturePage(page, destBase) {
  const { viewport, maxPageHeight, splitChunk, settleDelay } = config.capture;

  await scrollThrough(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await waitForImages(page);
  await sleep(settleDelay);

  const height = await pageHeight(page);

  if (height <= maxPageHeight) {
    const dest = `${destBase}.png`;
    await page.screenshot({ path: dest, type: 'png', fullPage: true });
    return [dest];
  }

  // 분할 경로 — 뷰포트를 임시로 키워 장수를 줄이고, 한 칸씩 스크롤하며 찍는다.
  const parts = Math.ceil(height / splitChunk);
  log(`  ✂ 문서 ${height}px — 한 장 한계 초과, ${parts}장으로 분할`);
  await page.setViewportSize({ width: viewport.width, height: splitChunk });
  const files = [];
  try {
    for (let i = 0; i < parts; i++) {
      const y = i * splitChunk;
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await sleep(400);
      const dest = `${destBase}_${i + 1}.png`;
      await page.screenshot({ path: dest, type: 'png' });
      files.push(dest);
    }
  } finally {
    await page.setViewportSize(viewport).catch(() => {});
  }
  return files;
}

// 한 화면씩 끝까지 내려가며 lazy 이미지/무한스크롤을 불러온다. 높이가 더 안 늘면 종료.
async function scrollThrough(page) {
  const { scrollRatio, scrollDelay, maxScrollLoops } = config.capture;
  let stable = 0;
  let prev = 0;
  for (let i = 0; i < maxScrollLoops && stable < 3; i++) {
    const { atBottom, height } = await page.evaluate((ratio) => {
      const el = document.scrollingElement || document.documentElement;
      el.scrollBy(0, Math.round(el.clientHeight * ratio));
      return {
        atBottom: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
        height: el.scrollHeight,
      };
    }, scrollRatio);
    await sleep(scrollDelay);
    stable = atBottom && height === prev ? stable + 1 : 0;
    prev = height;
  }
}

// 아직 디코드 안 된 <img>를 기다린다(상한 있음). 깨진 이미지는 error 로 즉시 통과.
async function waitForImages(page) {
  await page.evaluate((timeout) => {
    const pending = [...document.images].filter((img) => !img.complete);
    if (!pending.length) return;
    const settled = pending.map((img) => new Promise((r) => { img.addEventListener('load', r); img.addEventListener('error', r); }));
    return Promise.race([Promise.all(settled), new Promise((r) => setTimeout(r, timeout))]);
  }, config.timeouts.imageLoad).catch(() => {});
}

function pageHeight(page) {
  return page.evaluate(() => {
    const el = document.scrollingElement || document.documentElement;
    return Math.max(el.scrollHeight, document.body?.scrollHeight || 0);
  });
}
