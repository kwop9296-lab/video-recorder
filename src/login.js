// 로그인 창 — 사이트 프로필에 로그인 세션을 심어둔다. 최초 1회(그리고 세션 만료 시)만 쓴다.
//   pnpm login najuda            사이트 이름으로
//   pnpm login mimosa            catalog 이름으로 (그 catalog의 사이트를 자동 판정)
//   pnpm login "<아무 URL>"      URL의 호스트로 판정
//
// 비밀번호는 이 도구가 입력하지 않는다. 열린 창에서 직접 로그인하면 프로필에 저장되고,
// 이후 pnpm urls / shot / start 가 그 세션을 재사용한다.

import 'dotenv/config';
import { config } from './core/config.js';
import { log } from './core/logger.js';
import { launchSession, ensureLoggedIn, isLoggedIn } from './browser/session.js';
import { siteById, siteForUrl, siteForItems, listSiteIds } from './sites/index.js';
import { loadCatalog, listCatalogNames } from './core/catalog.js';
import { loadSources } from './core/sources.js';

const isUrl = (s) => /^https?:\/\//i.test(s);
const arg = process.argv.slice(2).find((a) => !a.startsWith('-'));

const sources = await loadSources();
const catalogs = await listCatalogNames();

if (!arg) {
  console.log('사용법:  pnpm login <사이트|catalog이름|URL>');
  console.log(`\n사이트: ${listSiteIds().join(', ')}`);
  if (catalogs.length) console.log(`catalog: ${catalogs.join(', ')}`);
  process.exit(0);
}

// ── 대상 사이트 + 로그인 후 확인용 URL 결정
let site = null;
let probeUrl = '';
if (isUrl(arg)) {
  site = siteForUrl(arg);
  probeUrl = arg;
} else if (siteById(arg)) {
  site = siteById(arg);
  probeUrl = sources[Object.keys(sources).find((n) => siteForUrl(sources[n]).id === arg)] || '';
} else if (catalogs.includes(arg) || sources[arg]) {
  probeUrl = sources[arg] || '';
  site = probeUrl ? siteForUrl(probeUrl) : siteForItems(await loadCatalog(arg));
} else {
  console.error(`'${arg}' 를 모르겠습니다.  사이트: ${listSiteIds().join(', ')}${catalogs.length ? ` · catalog: ${catalogs.join(', ')}` : ''}`);
  process.exit(1);
}

log(`🔑 ${site.label} 로그인 창 — 프로필: ${config.userDataDirFor(site.id)}`);
const context = await launchSession({ site, viewport: config.capture.viewport });

let closing = false;
const shutdown = async (code) => {
  if (closing) return;
  closing = true;
  try { await context.close(); } catch (_) {}
  process.exit(code);
};
process.on('SIGINT', () => shutdown(0));

try {
  await ensureLoggedIn(context, { timeout: 900000, returnTo: probeUrl }); // 15분
  if (probeUrl) {
    const page = context.pages()[0] || (await context.newPage());
    // 로그인 후 사이트가 알아서 돌려보냈으면 그대로 두고, 아니면 직접 연다.
    if (!page.url().startsWith(probeUrl.split('#')[0])) {
      await page.goto(probeUrl, { waitUntil: 'domcontentloaded' }).catch(() => {});
    }
    log('👀 확인용으로 목록 페이지를 열었습니다 — 콘텐츠가 잠금 없이 보이면 정상입니다.');
  }
  log(`\n✅ ${site.label} 로그인 세션 저장됨.  확인이 끝나면 Ctrl+C 로 닫으세요.`);
  log(`   (다시 확인: ${(await isLoggedIn(context)) ? '로그인됨' : '로그인 안 됨'})`);
  await new Promise(() => {}); // Ctrl+C 까지 대기
} catch (e) {
  console.error('실행 오류:', e.message);
  await shutdown(1);
}
