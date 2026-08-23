// 목록 가져오기 — 카테고리 목록 페이지에서 콘텐츠(제목+URL)를 긁어 종류별 catalog에 병합.
//   pnpm urls "<목록페이지URL>" <catalog이름>   ← URL을 data/sources.json 에 자동 등록
//   pnpm urls <catalog이름> [이름...]           ← 등록된 URL로 갱신 (여러 개 나열 가능)
//   pnpm urls all                               ← 등록된 전부를 브라우저 한 번만 띄워 순차 갱신
//   pnpm urls                                   ← 등록 목록 보기
// 완료 여부는 Drive 기준이라, 병합해도 진행상황이 안 날아간다. 출력에 ✅/⬜/⏭(영상없음) 로 보여줌.
// 순서는 매번 사이트 목록 순서(최신이 위)로 다시 잡는다 → 새 콘텐츠가 맨 위 + 최신부터 녹화.

import 'dotenv/config';
import { config } from './core/config.js';
import { log } from './core/logger.js';
import { launchSession, ensureLoggedIn } from './browser/session.js';
import { contentId, mergeCatalog, saveCatalog, catalogPath } from './core/catalog.js';
import { loadSources, setSource, sourcesPath } from './core/sources.js';
import { DriveClient } from './drive/driveClient.js';

const USAGE = [
  '사용법:',
  '  pnpm urls <이름> [이름...]              등록된 URL로 갱신  (예: pnpm urls hong)',
  '  pnpm urls all                          등록된 전부 갱신',
  '  pnpm urls "<카테고리 목록URL>" <이름>    URL 등록 + 갱신 (최초 1회)',
  '  pnpm urls                              등록 목록 보기',
].join('\n');

const isUrl = (s) => /^https?:\/\//i.test(s);
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const sources = await loadSources();
const known = Object.keys(sources);

// ── 대상 결정: [{ name, url }]
let targets = [];
if (!argv.length) {
  console.log(USAGE);
  if (known.length) {
    console.log('\n등록된 catalog:');
    for (const n of known) console.log(`  ${n.padEnd(14)} ${sources[n]}`);
    console.log(`\n📄 ${sourcesPath()}`);
  } else {
    console.log('\n(등록된 URL 없음 — URL과 이름을 함께 한 번 실행하면 자동 등록됩니다)');
  }
  process.exit(0);
} else if (isUrl(argv[0])) {
  const [url, name] = argv;
  if (!name) { console.error('catalog 이름이 없습니다.\n\n' + USAGE); process.exit(1); }
  if (await setSource(name, url)) log(`📌 '${name}' URL 등록 — 다음부터는  pnpm urls ${name}`);
  targets = [{ name, url }];
} else if (argv.length === 1 && /^all$/i.test(argv[0]) && !sources.all) {
  // 'all'이라는 이름의 catalog가 실제로 등록돼 있으면 그건 이름으로 취급(아래 분기)
  if (!known.length) { console.error('등록된 URL이 없습니다.\n\n' + USAGE); process.exit(1); }
  targets = known.map((name) => ({ name, url: sources[name] }));
} else {
  for (const name of argv) {
    const url = sources[name];
    if (!url) {
      console.error(`'${name}' 은 등록되어 있지 않습니다.  등록된 것: ${known.join(', ') || '(없음)'}`);
      console.error(`\n최초 1회만:  pnpm urls "<카테고리 목록URL>" ${name}`);
      process.exit(1);
    }
    targets.push({ name, url });
  }
}

if (!config.drive.rootFolder) {
  console.error('GDRIVE_ROOT 미설정 — .env 에 GDRIVE_ROOT 를 지정하세요.');
  process.exit(1);
}

// ── 목록 페이지 수집 (브라우저 한 번만 띄워 여러 대상을 순회)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RE = /\/contents\/[0-9A-Za-z]{8,}$/;
const isPlaceholder = (t) => !t || /^(동영상|재생|재생하기|이미지|썸네일)$/.test(t);

async function collectList(page, listUrl) {
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
  return found;
}

const context = await launchSession({ headless: config.headless });
await ensureLoggedIn(context);
const page = context.pages()[0];

// 한 대상이 실패해도 나머지는 계속 진행 (all 로 여러 개 돌 때 중간에 멈추지 않게)
const collected = []; // { name, items }
for (let i = 0; i < targets.length; i++) {
  const t = targets[i];
  if (targets.length > 1) log(`\n──── ${t.name} (${i + 1}/${targets.length}) ────`);
  try {
    const found = await collectList(page, t.url);
    collected.push({
      name: t.name,
      items: [...found].map(([url, title]) => ({ id: contentId(url), title: title || contentId(url), url })),
    });
  } catch (e) {
    console.error(`❌ '${t.name}' 수집 실패 —`, e.message);
  }
}
await context.close();

// ── catalog 병합 + 완료 표시 (브라우저는 이미 닫힘)
// Drive 클라이언트는 한 번만 만들고, 대상별로 하위폴더만 조회한다.
let drive = null;
let rootId = null;
try {
  drive = new DriveClient();
  rootId = await drive.ensureFolder(config.drive.rootFolder);
} catch (e) {
  log('(드라이브 연결 실패 —', e.message, '· done 표시는 이전 스냅샷 유지)');
  drive = null;
}

const summary = [];
for (const { name, items } of collected) {
  // catalog 병합 (사이트 순서로 재정렬 + 새 항목 추가, 기존 항목은 유실 없음)
  const { merged, added } = await mergeCatalog(name, items);

  // Drive에서 완료 목록 조회해 ✅ 표시 (best-effort)
  let doneIds = null;
  if (drive) {
    try {
      const folderId = await drive.ensureFolder(name, rootId);
      doneIds = new Set((await drive.listFiles(folderId)).map((f) => f.appProperties?.contentId).filter(Boolean));
    } catch (e) { log(`(드라이브 완료조회 실패 '${name}' —`, e.message, '· done 표시는 이전 스냅샷 유지)'); }
  }

  // 완료 스냅샷을 파일에도 남김(눈으로 확인용. 실제 기준은 Drive라 병합해도 안전).
  // 조회 실패 시엔 덮어쓰지 않는다 — 전부 미완료로 보이는 오해 방지.
  if (doneIds) for (const m of merged) m.done = doneIds.has(m.id);
  await saveCatalog(name, merged);

  if (collected.length > 1) console.log(`\n════ ${name} ════`);
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
  const limit = collected.length > 1 ? 10 : 40; // 여러 개 갱신할 땐 목록을 짧게
  merged.slice(0, limit).forEach((m) => console.log(`  ${mark(m)} ${m.title}`));
  if (merged.length > limit) console.log(`  ... 외 ${merged.length - limit}개`);
  console.log(`\n📄 ${catalogPath(name)}`);
  summary.push({ name, added: added.length, todo: todoN });
}

if (summary.length > 1) {
  console.log('\n════ 전체 요약 ════');
  for (const s of summary) {
    console.log(`  ${s.name.padEnd(14)} 신규 ${String(s.added).padStart(3)} · 남음 ${String(s.todo).padStart(3)}`);
  }
  console.log('\n→ 녹화:  pnpm start <이름>');
} else if (summary.length === 1) {
  console.log('→ 녹화:  pnpm start ' + summary[0].name);
}

process.exit(0);
