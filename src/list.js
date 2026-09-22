// 목록 가져오기 — 카테고리 목록 페이지에서 콘텐츠(제목+URL)를 긁어 종류별 catalog에 병합.
//   pnpm urls "<목록페이지URL>" <catalog이름>   ← URL을 data/sources.json 에 자동 등록
//   ... --account=<이름>                       ← 같은 사이트의 두 번째 아이디로 (한 번 등록하면 이후 자동)
//   pnpm urls <catalog이름> [이름...]           ← 등록된 URL로 갱신 (여러 개 나열 가능)
//   pnpm urls all                               ← 등록된 전부를 브라우저 한 번만 띄워 순차 갱신
//   pnpm urls                                   ← 등록 목록 보기
// 완료 여부는 Drive 기준이라, 병합해도 진행상황이 안 날아간다. 출력에 ✅/⬜/⏭(영상없음) 로 보여줌.
// 순서는 매번 사이트 목록 순서(최신이 위)로 다시 잡는다 → 새 콘텐츠가 맨 위 + 최신부터 녹화.

import 'dotenv/config';
import { config } from './core/config.js';
import { log } from './core/logger.js';
import { launchSession, ensureLoggedIn } from './browser/session.js';
import { mergeCatalog, saveCatalog, catalogPath } from './core/catalog.js';
import { loadSources, setSource, sourcesPath, accountFromArgv } from './core/sources.js';
import { siteForUrl } from './sites/index.js';
import { DriveClient } from './drive/driveClient.js';

const USAGE = [
  '사용법:',
  '  pnpm urls <이름> [이름...]              등록된 URL로 갱신  (예: pnpm urls hong)',
  '  pnpm urls all                          등록된 전부 갱신',
  '  pnpm urls "<카테고리 목록URL>" <이름>    URL 등록 + 갱신 (최초 1회)',
  '  pnpm urls                              등록 목록 보기',
  '',
  '  --account=<이름>   같은 사이트의 다른 아이디로 (등록 시 기록 → 이후엔 안 붙여도 됨)',
].join('\n');

const isUrl = (s) => /^https?:\/\//i.test(s);
const accountFlag = accountFromArgv();
const argv = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const sources = await loadSources();
const known = Object.keys(sources);

// ── 대상 결정: [{ name, url }]
let targets = [];
if (!argv.length) {
  console.log(USAGE);
  if (known.length) {
    console.log('\n등록된 catalog:');
    for (const n of known) {
      const acc = sources[n].account ? `  [계정: ${sources[n].account}]` : '';
      console.log(`  ${n.padEnd(14)} ${sources[n].url}${acc}`);
    }
    console.log(`\n📄 ${sourcesPath()}`);
  } else {
    console.log('\n(등록된 URL 없음 — URL과 이름을 함께 한 번 실행하면 자동 등록됩니다)');
  }
  process.exit(0);
} else if (isUrl(argv[0])) {
  const [url, name] = argv;
  if (!name) { console.error('catalog 이름이 없습니다.\n\n' + USAGE); process.exit(1); }
  if (await setSource(name, url, accountFlag || null)) log(`📌 '${name}' 등록${accountFlag ? ` (계정 ${accountFlag})` : ''} — 다음부터는  pnpm urls ${name}`);
  targets = [{ name, url, account: accountFlag }];
} else if (argv.length === 1 && /^all$/i.test(argv[0]) && !sources.all) {
  // 'all'이라는 이름의 catalog가 실제로 등록돼 있으면 그건 이름으로 취급(아래 분기)
  if (!known.length) { console.error('등록된 URL이 없습니다.\n\n' + USAGE); process.exit(1); }
  targets = known.map((name) => ({ name, url: sources[name].url, account: accountFlag || sources[name].account }));
} else {
  for (const name of argv) {
    const url = sources[name]?.url;
    if (!url) {
      console.error(`'${name}' 은 등록되어 있지 않습니다.  등록된 것: ${known.join(', ') || '(없음)'}`);
      console.error(`\n최초 1회만:  pnpm urls "<카테고리 목록URL>" ${name}`);
      process.exit(1);
    }
    targets.push({ name, url, account: accountFlag || sources[name].account });
  }
}

if (!config.drive.rootFolder) {
  console.error('GDRIVE_ROOT 미설정 — .env 에 GDRIVE_ROOT 를 지정하세요.');
  process.exit(1);
}

// ── 목록 페이지 수집
// 대상을 사이트별로 묶어, 사이트마다 브라우저를 한 번만 띄워 순차 수집한다.
// (사이트마다 프로필이 달라서 한 창으로는 두 사이트를 볼 수 없다)
// 계정이 다르면 프로필이 달라 한 창으로 못 본다 → (사이트, 계정) 조합으로 묶는다.
const bySite = new Map(); // "siteId/account" -> { site, account, targets[] }
for (const t of targets) {
  const site = siteForUrl(t.url);
  const key = `${site.id}/${t.account || ''}`;
  if (!bySite.has(key)) bySite.set(key, { site, account: t.account || '', targets: [] });
  bySite.get(key).targets.push(t);
}

const collected = []; // { name, items }
for (const { site, account, targets: group } of bySite.values()) {
  if (bySite.size > 1) log(`\n════ ${site.label}${account ? ` (${account})` : ''} ════`);
  const context = await launchSession({ headless: config.headless, site, account });
  try {
    // 로그인이 필요하면 첫 대상 목록으로 돌아오게 한다 — 최초 등록 때 바로 확인이 된다.
    await ensureLoggedIn(context, { returnTo: group[0].url });
    const page = context.pages()[0] || (await context.newPage());
    // 한 대상이 실패해도 나머지는 계속 진행 (all 로 여러 개 돌 때 중간에 멈추지 않게)
    for (let i = 0; i < group.length; i++) {
      const t = group[i];
      if (targets.length > 1) log(`\n──── ${t.name} (${i + 1}/${group.length}) ────`);
      try {
        collected.push({ name: t.name, items: await site.collectList(page, t.url) });
      } catch (e) {
        console.error(`❌ '${t.name}' 수집 실패 —`, e.message);
      }
    }
  } finally {
    await context.close();
  }
}

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
