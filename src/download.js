// 진입점 (옵션 C 직접 다운로드) — data/videos.json 을 읽어 다운로더 실행.
//   pnpm download            (헤드리스는 .env HEADLESS=1)
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './core/config.js';
import { runDownload } from './downloader/downloader.js';

const listPath = path.join(config.root, 'data', 'videos.json');

let raw;
try {
  raw = JSON.parse(await fs.readFile(listPath, 'utf8'));
} catch (e) {
  console.error(`data/videos.json 을 읽을 수 없습니다: ${e.message}`);
  process.exit(1);
}
if (!Array.isArray(raw) || raw.length === 0) {
  console.error('data/videos.json 이 비어있습니다.');
  process.exit(1);
}

const videos = [];
raw.forEach((entry, i) => {
  const e = typeof entry === 'string' ? { url: entry } : entry;
  if (!e || !e.url || /여기에|실제\/영상/.test(e.url)) {
    console.error(`[${i + 1}] 유효한 url 이 없습니다:`, JSON.stringify(entry));
    return;
  }
  let seg = 'video';
  try { seg = new URL(e.url).pathname.split('/').filter(Boolean).pop() || 'video'; } catch (_) {}
  videos.push({ name: e.name || null, url: e.url, fallback: `${String(i + 1).padStart(2, '0')}_${seg}` });
});
if (videos.length === 0) { console.error('유효한 항목이 없습니다.'); process.exit(1); }

const results = await runDownload(videos);

console.log('\n==== 결과 ====');
for (const r of results) console.log(r.ok ? '✅' : '❌', r.ok ? r.file : r.url + ' · ' + r.error);
const okN = results.filter((r) => r.ok).length;
console.log(`\n총 ${results.length}개 중 ${okN}개 성공`);
process.exit(0);
