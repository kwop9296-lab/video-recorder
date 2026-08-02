// 목록 가져오기 — 카테고리 목록 페이지에서 콘텐츠(제목+URL)를 긁어 종류별 catalog에 병합.
//   pnpm urls "<목록페이지URL>" <catalog이름>
// 완료 여부는 Drive 기준이라, 병합해도 진행상황이 안 날아간다. 출력에 ✅/⬜/⏭(영상없음) 로 보여줌.
// 순서는 매번 사이트 목록 순서(최신이 위)로 다시 잡는다 → 새 콘텐츠가 맨 위 + 최신부터 녹화.

import 'dotenv/config';
import { config } from './core/config.js';
import { log } from './core/logger.js';
import { launchSession, ensureLoggedIn } from './browser/session.js';
import { contentId, mergeCatalog, saveCatalog, catalogPath } from './core/catalog.js';
import { DriveClient } from './drive/driveClient.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const listUrl = args[0];
const name = args[1];
if (!listUrl || !name) {
  console.error('사용법:  pnpm urls "<카테고리 목록URL>" <catalog이름>   (예: pnpm urls "https://..." no1-stock)');
  process.exit(1);
}
if (!config.drive.rootFolder) {
  console.error('GDRIVE_ROOT 미설정 — .env 에 GDRIVE_ROOT 를 지정하세요.');
  process.exit(1);
}

const context = await launchSession({ headless: config.headless });
await ensureLoggedIn(context);
const page = context.pages()[0];

log('🌐 목록 이동:', listUrl);
await page.goto(listUrl, { waitUntil: 'domcontentloaded' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /\/contents\/[0-9A-Za-z]{8,}$/;
const isPlaceholder = (t) => !t || /^(동영상|재생|재생하기|이미지|썸네일)$/.test(t);
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
await context.close();

// catalog 병합 (사이트 순서로 재정렬 + 새 항목 추가, 기존 항목은 유실 없음)
const items = [...found].map(([url, title]) => ({ id: contentId(url), title: title || contentId(url), url }));
const { merged, added } = await mergeCatalog(name, items);

// Drive에서 완료 목록 조회해 ✅ 표시 (best-effort)
let doneIds = null;
try {
  const drive = new DriveClient();
  const rootId = await drive.ensureFolder(config.drive.rootFolder);
  const folderId = await drive.ensureFolder(name, rootId);
  doneIds = new Set((await drive.listFiles(folderId)).map((f) => f.appProperties?.contentId).filter(Boolean));
} catch (e) { log('(드라이브 완료조회 실패 —', e.message, '· done 표시는 이전 스냅샷 유지)'); }

// 완료 스냅샷을 파일에도 남김(눈으로 확인용. 실제 기준은 Drive라 병합해도 안전).
// 조회 실패 시엔 덮어쓰지 않는다 — 전부 미완료로 보이는 오해 방지.
if (doneIds) for (const m of merged) m.done = doneIds.has(m.id);
await saveCatalog(name, merged);

if (added.length) {
  console.log(`\n🆕 신규 ${added.length}개`);
  added.slice(0, 20).forEach((a) => console.log(`  + ${a.title}`));
  if (added.length > 20) console.log(`  ... 외 ${added.length - 20}개`);
} else {
  console.log('\n🆕 신규 없음 (사이트 목록과 동일)');
}

// 영상없음(skip)은 큐에서 빠지므로 '남음'에서도 뺀다 — pnpm start 의 집계와 숫자를 맞춘다.
const mark = (m) => (m.skip === 'novideo' ? '⏭' : m.done ? '✅' : '⬜');
const doneN = merged.filter((m) => m.done).length;
const novideoN = merged.filter((m) => m.skip === 'novideo').length;
const todoN = merged.filter((m) => !m.done && m.skip !== 'novideo').length;
const stale = doneIds ? '' : ' · (완료수=이전 스냅샷)';
console.log(`\ncatalog '${name}': 총 ${merged.length} · 완료 ${doneN} · 영상없음 ${novideoN} · 남음 ${todoN}${stale}`);
merged.slice(0, 40).forEach((m) => console.log(`  ${mark(m)} ${m.title}`));
if (merged.length > 40) console.log(`  ... 외 ${merged.length - 40}개`);
console.log(`\n📄 ${catalogPath(name)}`);
console.log('→ 녹화:  pnpm start ' + name);

process.exit(0);
