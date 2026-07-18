// 스트림 발견 — 재생을 시작시켜, 내 브라우저가 스스로 보낸 HLS 매니페스트/세그먼트
// 요청을 관찰한다. (크롬 F12 → Network 탭과 동일한 "내 요청 보기". 남의 트래픽 가로채기 아님.)
// 영상 전체를 받지 않고 주소·구조만 확인한다. 옵션 C "직접 다운로드"의 첫 단계.
//
//   pnpm discover "<영상URL>"    (생략 시 .env TARGET_URL 또는 videos.json[0])

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../core/config.js';
import { launchSession, ensureLoggedIn } from '../browser/session.js';
import { openContent } from '../browser/navigator.js';
import { installProbe, VideoController } from '../browser/videoProbe.js';

let url = process.argv[2] || process.env.TARGET_URL;
if (!url) {
  try { url = JSON.parse(await fs.readFile(path.join(config.root, 'data', 'videos.json'), 'utf8'))[0]; } catch (_) {}
  if (url && typeof url === 'object') url = url.url;
}
if (!url) { console.error('URL이 없습니다. pnpm discover "<영상URL>"'); process.exit(1); }

const manifestBodies = new Map(); // url -> body
const reqHeaders = new Map();     // url -> request headers
const segs = [];

const context = await launchSession();
const bus = await installProbe(context, config.selectors.video);
await ensureLoggedIn(context);
const page = context.pages()[0];

// 캐시를 꺼서 매니페스트가 디스크 캐시에서 로드돼 요청이 안 잡히는 걸 방지
try {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
} catch (e) { console.log('  (캐시 비활성화 경고:', e.message, ')'); }

page.on('request', (req) => {
  const u = req.url();
  if (/\.m3u8|\.mpd/i.test(u)) reqHeaders.set(u, req.headers());
  if (/\.ts(\?|$)|\.m4s|\.cmf/i.test(u) && segs.length < 4) { segs.push(u); console.log('🧩 SEG', u.slice(0, 180)); }
});

// 매니페스트 감지: URL(.m3u8/.mpd) 또는 content-type 또는 본문(#EXTM3U). 뻔한 바이너리는 건너뜀.
async function maybeManifest(res) {
  const u = res.url();
  if (manifestBodies.has(u)) return;
  const ct = (res.headers()['content-type'] || '').toLowerCase();
  const urlHit = /\.m3u8|\.mpd/i.test(u);
  const ctHit = /mpegurl|dash\+xml/i.test(ct);
  if (!urlHit && !ctHit && /\.ts(\?|$)|\.m4s|\.cmf|\.(png|jpe?g|gif|webp|css|js|woff2?|mp4|m4a|aac|svg|ico|woff)(\?|$)/i.test(u)) return;
  let body = '';
  try { body = await res.text(); } catch (_) { return; }
  if (urlHit || ctHit || body.startsWith('#EXTM3U') || body.includes('<MPD')) {
    manifestBodies.set(u, body);
    const tag = body.startsWith('#EXTM3U') && !urlHit ? '(본문감지)' : '';
    console.log(`📄 MANIFEST${tag}`, u.slice(0, 180), '[' + ct + ']');
  }
}
page.on('response', (res) => { maybeManifest(res).catch(() => {}); });

const frame = await openContent(page, url, { selector: config.selectors.video, timeout: config.timeouts.playerAppear });
const vc = new VideoController({ page, frame, bus, selectors: config.selectors, margin: 0 });

await vc.startPlayback();
console.log('▶ 재생 시작 — 매니페스트 수집 중...');
await new Promise((r) => setTimeout(r, 4000));
await vc.setQuality('1080p').catch((e) => console.log('  1080p 설정 경고:', e.message));
await new Promise((r) => setTimeout(r, 6000));

// ── 요약 ──────────────────────────────────────────────
console.log('\n════════ 요약 ════════');
console.log(`매니페스트 ${manifestBodies.size}개, 세그먼트 샘플 ${segs.length}개\n`);

for (const [u, body] of manifestBodies) {
  console.log('▶ 매니페스트 URL:', u);
  const h = reqHeaders.get(u) || {};
  console.log('   요청 헤더 → Cookie:', h.cookie ? '(있음)' : '(없음)', '| Referer:', h.referer || '(없음)', '| Origin:', h.origin || '(없음)');
  const master = /#EXT-X-STREAM-INF/i.test(body);
  const enc = /#EXT-X-KEY/i.test(body) ? '⚠ 암호화(#EXT-X-KEY) 있음' : '암호화 없음';
  console.log(`   종류: ${master ? 'MASTER(화질목록)' : 'MEDIA(세그먼트목록)'} · ${enc}`);
  console.log(body.split('\n').slice(0, 40).map((l) => '     ' + l).join('\n'));
  console.log('');
}
if (segs.length) console.log('세그먼트 예:', segs[0]);

const cookies = await context.cookies();
console.log('\n현재 쿠키(이름만):', cookies.map((c) => c.name).join(', '));
console.log('\n위 매니페스트 URL/내용(MASTER인지 MEDIA인지, 암호화, 세그먼트 참조 방식)을 공유해주세요.');
console.log('Ctrl+C 로 종료.');

await new Promise(() => {});
