// 직접 다운로드 오케스트레이터 (옵션 C) — OBS/화면 없이, 실시간보다 빠르게, 무손실.
// 흐름: 브라우저(헤드리스 가능)로 재생을 트리거해 playback MPD를 낚아채고,
//       MPD에서 1080p 완성 MP4 URL을 뽑아 HTTP로 스트리밍 다운로드한다.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../core/config.js';
import { log, err } from '../core/logger.js';
import { launchSession, ensureLoggedIn } from '../browser/session.js';
import { openContent, getContentTitle } from '../browser/navigator.js';
import { installProbe, VideoController } from '../browser/videoProbe.js';
import { pickProgressiveMp4, pickHlsPlaylist } from './mpd.js';

export async function runDownload(videos) {
  await fsp.mkdir(config.recordDir, { recursive: true });

  const context = await launchSession({ headless: config.headless });
  const bus = await installProbe(context, config.selectors.video);
  await ensureLoggedIn(context);
  const page = context.pages()[0] || (await context.newPage());

  const results = [];
  const used = new Set();

  for (const [i, v] of videos.entries()) {
    log(`\n[${i + 1}/${videos.length}] ${v.url}`);
    try {
      const { title, mp4, hls } = await findStream(page, bus, v.url);
      const base = sanitize(v.name || title || v.fallback).slice(0, 80) || v.fallback;
      const name = uniqueName(base, used);
      log('  📄 제목:', name, hls && !mp4 ? '' : `(${mp4?.w}x${mp4?.h})`);

      if (!mp4) throw new Error(hls ? `프로그레시브 MP4 없음 → HLS(ffmpeg) 폴백 필요: ${hls.url}` : '다운로드 소스 없음');

      const dest = path.join(config.recordDir, name + '.mp4');
      log('  ⬇ 다운로드 시작...');
      await downloadFile(mp4.url, dest, v.url);
      results.push({ url: v.url, ok: true, file: dest });
      log('  ✅ 저장:', dest);
    } catch (e) {
      err('  ❌ 실패:', e.message);
      results.push({ url: v.url, ok: false, error: e.message });
    }
  }

  await context.close();
  return results;
}

// 콘텐츠 열고 재생 트리거 → playback MPD 포착 → { title, mp4, hls }
async function findStream(page, bus, url) {
  let mpd = null;
  const onResp = async (res) => {
    if (mpd) return;
    const u = res.url();
    if (/neonplayer\/vodplay|\/playback\/|\.mpd(\?|$)/i.test(u)) {
      try { const b = await res.text(); if (b.includes('<MPD')) mpd = b; } catch (_) {}
    }
  };
  page.on('response', onResp);
  try {
    const frame = await openContent(page, url, { selector: config.selectors.video, timeout: config.timeouts.playerAppear });
    const title = await getContentTitle(frame);
    const vc = new VideoController({ page, frame, bus, selectors: config.selectors, margin: 0 });
    await vc.startPlayback().catch(() => {}); // 재생 실패해도 MPD가 로드 시 뜰 수 있음
    for (let i = 0; i < 40 && !mpd; i++) await new Promise((r) => setTimeout(r, 300));
    if (!mpd) throw new Error('재생 매니페스트(MPD)를 못 찾음');
    return { title, mp4: pickProgressiveMp4(mpd), hls: pickHlsPlaylist(mpd) };
  } finally {
    page.off('response', onResp);
  }
}

// 스트리밍 다운로드 (.part 로 받고 완료 시 rename). 서명 토큰이 인증하므로 쿠키 불필요.
async function downloadFile(url, dest, referer) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0',
      Referer: referer || 'https://contents.premium.naver.com/',
      Accept: '*/*',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const tmp = dest + '.part';
  const out = fs.createWriteStream(tmp);
  let done = 0;
  let last = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done: d, value } = await reader.read();
    if (d) break;
    done += value.length;
    if (!out.write(Buffer.from(value))) await new Promise((r) => out.once('drain', r));
    if (total && done - last > total / 20) {
      last = done;
      process.stdout.write(`\r   ${(done / 1048576).toFixed(1)}/${(total / 1048576).toFixed(1)} MB (${((done / total) * 100).toFixed(0)}%)`);
    }
  }
  await new Promise((r) => out.end(r));
  if (total) process.stdout.write('\n');
  await fsp.rm(dest, { force: true }).catch(() => {});
  await fsp.rename(tmp, dest);
}

function sanitize(name) { return String(name).replace(/[<>:"/\\|?*\n\r\t]+/g, '_').replace(/\.+$/, '').trim() || 'video'; }
function uniqueName(base, used) {
  let name = base || 'video';
  let n = 2;
  while (used.has(name.toLowerCase())) name = `${base}_${n++}`;
  used.add(name.toLowerCase());
  return name;
}
