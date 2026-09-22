// 페이지를 끝까지 훑어 lazy 콘텐츠를 모두 불러온 뒤 PNG로 캡처한다.
// 기본은 전체페이지 한 장. 문서가 Chromium 한 장 한계(약 16000px)를 넘으면 화면 단위로 나눠 찍고,
// 찍은 조각을 다시 세로로 이어붙여 '긴 한 장'으로 돌려준다(config.capture.stitch).
// 이어붙이기가 불가능하면(너무 김 · sharp 없음) 조각 그대로 반환한다 — 캡처 자체는 실패하지 않는다.

import fsp from 'node:fs/promises';
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

// destBase = 확장자 없는 경로. 반환: 실제로 저장된 파일 경로 배열(보통 1개).
export async function capturePage(page, destBase) {
  const { viewport, maxPageHeight, splitChunk, settleDelay, stitch, stitchMaxHeight } = config.capture;

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

  // ── 분할 촬영: 뷰포트를 키워 컷 수를 줄이고, 한 칸씩 내려가며 찍는다.
  log(`  ✂ 문서 ${height}px — 한 장 한계(${maxPageHeight}px) 초과, 나눠 찍는 중...`);
  await page.setViewportSize({ width: viewport.width, height: splitChunk });
  await sleep(300);
  await waitForImages(page);
  await freezeOverlays(page); // 고정 상단바가 컷마다 따라오지 않도록 (이어붙였을 때 반복 방지)

  const shots = []; // { file, top } — top은 '요청한 위치'가 아니라 '실제로 내려간 위치'
  let total = 0;
  try {
    let want = 0;
    for (let i = 0; i < 200; i++) { // 안전장치 (200컷 = 160만px)
      const pos = await page.evaluate((y) => {
        window.scrollTo(0, y);
        const el = document.scrollingElement || document.documentElement;
        return { top: Math.round(el.scrollTop), height: Math.max(el.scrollHeight, document.body?.scrollHeight || 0) };
      }, want);
      await sleep(400);
      const file = `${destBase}_${i + 1}.png`;
      await page.screenshot({ path: file, type: 'png' });
      // 마지막 컷은 문서 끝에 걸려 스크롤이 덜 내려간다(=앞 컷과 겹침).
      // 실제 위치를 기록해 두면 이어붙일 때 겹친 만큼 제자리에 덮여 이음매가 생기지 않는다.
      shots.push({ file, top: pos.top });
      total = pos.top + splitChunk;
      if (pos.top + splitChunk >= pos.height - 2) break; // 바닥 도달
      want = pos.top + splitChunk;
    }
  } finally {
    await restoreOverlays(page);
    await page.setViewportSize(viewport).catch(() => {});
  }

  const files = shots.map((s) => s.file);
  if (!stitch) return files;
  if (total > stitchMaxHeight) {
    log(`  (문서 ${total}px — 이어붙이기 한도(${stitchMaxHeight}px) 초과 → ${files.length}장으로 나눠 저장)`);
    return files;
  }
  if (!(await stitchVertical(shots, viewport.width, total, `${destBase}.png`))) return files;

  for (const f of files) await fsp.rm(f, { force: true }).catch(() => {});
  log(`  🧵 ${files.length}컷 이어붙임 → 1장 (${viewport.width}×${total}px)`);
  return [`${destBase}.png`];
}

// 화면에 붙어 따라다니는 요소를 잠시 떼어낸다 — 분할 촬영에서만 쓴다.
// sticky 는 흐름 안에 있으므로 static 으로 바꿔도 레이아웃(문서 높이)이 변하지 않고,
// fixed 는 애초에 흐름 밖이라 숨겨도 높이가 변하지 않는다.
async function freezeOverlays(page) {
  await page.evaluate(() => {
    window.__recFrozen = [];
    for (const el of document.querySelectorAll('body *')) {
      const pos = getComputedStyle(el).position;
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      window.__recFrozen.push({ el, position: el.style.position, display: el.style.display });
      if (pos === 'sticky') el.style.position = 'static';
      else el.style.display = 'none';
    }
    return window.__recFrozen.length;
  }).catch(() => {});
}

async function restoreOverlays(page) {
  await page.evaluate(() => {
    for (const s of window.__recFrozen || []) { s.el.style.position = s.position; s.el.style.display = s.display; }
    window.__recFrozen = [];
  }).catch(() => {});
}

// 조각들을 세로로 합쳐 한 장으로. 실패하면 false (조각을 그대로 쓰도록).
async function stitchVertical(shots, width, height, dest) {
  let sharp;
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    log('  (sharp 미설치 — 이어붙이기 생략:', e.message, ')');
    return false;
  }
  try {
    await sharp({ create: { width, height, channels: 3, background: '#ffffff' } })
      .composite(shots.map((s) => ({ input: s.file, top: s.top, left: 0 })))
      .png({ compressionLevel: 9 })
      .toFile(dest);
    return true;
  } catch (e) {
    log('  (이어붙이기 실패 — 조각 그대로 둡니다:', e.message, ')');
    await fsp.rm(dest, { force: true }).catch(() => {});
    return false;
  }
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
