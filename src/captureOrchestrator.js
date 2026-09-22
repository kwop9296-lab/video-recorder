// 지휘자(캡처판) — catalog의 미완료 항목을 순회하며 페이지 캡처 → 드라이브 업로드.
// 녹화판과 달리 OBS·영상 제어를 전혀 쓰지 않고, 항목이 원자적(캡처 완료 후 업로드)이라
// 언제 STOP 해도 진행 중 항목만 버리면 끝이다.
// 완료 판정 폴더는 '<catalog>-shots' 로 녹화와 분리 — 두 기능이 서로의 완료 판정에 간섭하지 않는다.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './core/config.js';
import { log, err } from './core/logger.js';
import { launchSession, ensureLoggedIn, isLoggedIn } from './browser/session.js';
import { getContentTitle } from './browser/navigator.js';
import { openPage, capturePage } from './browser/pageCapture.js';
import { DriveClient, md5OfFile } from './drive/driveClient.js';
import { loadCatalog } from './core/catalog.js';
import { siteForItems } from './sites/index.js';
import { resolveAccount } from './core/sources.js';
import { sanitize } from './core/filename.js';
import { notifyFail, notifyLogin, notifyStopped, notifyCaptured } from './core/notify.js';

export const shotsFolderName = (catalogName) => `${catalogName}-shots`;

export async function run(catalogName, { reverse = false, account = '' } = {}) {
  if (!config.drive.rootFolder) throw new Error('GDRIVE_ROOT 미설정 — .env 에 GDRIVE_ROOT 를 지정하세요.');
  const items = await loadCatalog(catalogName);
  if (!items.length) { log(`catalog '${catalogName}' 이 비어있음. 먼저 pnpm urls 로 채우세요.`); return; }

  const site = siteForItems(items); // catalog 항목 URL로 사이트 판정 (프로필·로그인 방식이 갈림)
  const acct = await resolveAccount(catalogName, account); // 같은 사이트의 어느 아이디로 볼지
  const outDir = path.join(config.captureDir, catalogName);
  await fsp.mkdir(outDir, { recursive: true });

  log('☁ 드라이브 연결...');
  const drive = new DriveClient();
  const rootId = await drive.ensureFolder(config.drive.rootFolder);
  const folderId = await drive.ensureFolder(shotsFolderName(catalogName), rootId);
  // 완료 기준 = complete 표식이 붙은 파일이 있음. 분할 캡처가 중간에 끊긴 항목(표식 없음)은
  // 완료로 치지 않고 다음에 다시 캡처한다.
  const doneIds = new Set(
    (await drive.listFiles(folderId)).filter((f) => f.appProperties?.complete === '1')
      .map((f) => f.appProperties.contentId).filter(Boolean),
  );

  // 녹화와 달리 skip='novideo' 를 거르지 않는다 — 영상이 없어도 페이지는 캡처 대상이다.
  const todo = config.force ? [...items] : items.filter((i) => !doneIds.has(i.id));
  if (reverse) todo.reverse();
  log(`📋 '${catalogName}' 캡처: 총 ${items.length} · 완료 ${doneIds.size} · 남음 ${todo.length}${config.force ? ' · [FORCE]' : ''}${reverse ? ' · [역순]' : ''}`);
  if (!todo.length) { log('할 일 없음.'); return; }

  const context = await launchSession({ headless: config.headless, viewport: config.capture.viewport, site, account: acct });
  if (!(await isLoggedIn(context))) await notifyLogin(acct ? `${site.label}(${acct})` : site.label);
  await ensureLoggedIn(context);

  const page = context.pages()[0] || (await context.newPage());
  let doneThisSession = 0;
  let stopping = false;

  // STOP(Ctrl+C): 알림 먼저 보내고 정리. 진행 중 항목은 업로드 전이라 그냥 버리면 된다.
  process.on('SIGINT', async () => {
    if (stopping) return;
    stopping = true;
    err('\n⛔ STOP — 정리 중...');
    await notifyStopped(doneThisSession);
    try { await context.close(); } catch (_) {}
    process.exit(130);
  });

  for (const [i, v] of todo.entries()) {
    if (stopping) break;
    // 항목별 재확인 — 다른 PC(반대 방향)가 방금 올렸으면 스킵.
    const existing = config.force ? [] : await drive.listByContentId(folderId, v.id);
    if (existing.some((f) => f.appProperties?.complete === '1')) {
      doneIds.add(v.id);
      log(`[${i + 1}/${todo.length}] ⏭ 이미 완료(다른 PC) — ${v.title || v.url}`);
      continue;
    }
    log(`\n[${i + 1}/${todo.length}] ${v.title || v.url}`);
    try {
      const { title, files } = await captureOne(page, outDir, v, site);
      // 이전 시도의 잔재(끊긴 분할본·FORCE 재캡처분)를 먼저 치운다 — 중복 누적 방지.
      for (const f of config.force ? await drive.listByContentId(folderId, v.id) : existing) {
        await drive.deleteFile(f.id).catch(() => {});
      }
      log(`  ☁ 업로드 ${files.length}장...`);
      for (const [n, file] of files.entries()) {
        const last = n === files.length - 1;
        const up = await drive.uploadFile({
          folderId, name: path.basename(file), filePath: file, contentId: v.id,
          props: last ? { complete: '1' } : undefined, // 마지막 장에만 — 전부 올라가야 완료
        });
        const localMd5 = await md5OfFile(file);
        if (up.md5Checksum && up.md5Checksum !== localMd5) {
          await drive.deleteFile(up.id).catch(() => {});
          throw new Error(`업로드 무결성 불일치(md5) — ${n + 1}번째 장`);
        }
      }
      doneIds.add(v.id);
      doneThisSession++;
      log('  ✅ 완료·업로드:', title, '(로컬 보관)');
    } catch (e) {
      err('  ❌ 실패:', e.message);
      await notifyFail(v.title || v.id, e.message);
    }
  }

  await context.close();
  log(`\n세션 종료 — 이번에 ${doneThisSession}개 캡처.`);
  if (doneThisSession) await notifyCaptured(catalogName, doneThisSession);
  return { doneThisSession };
}

// 한 항목 캡처 → { title, files }
async function captureOne(page, outDir, v, site) {
  await openPage(page, v.url);
  if (site.assertAccessible) site.assertAccessible(page); // 로그인/권한 문제면 여기서 실패 처리

  const title = v.title || (await getContentTitle(page)) || v.id;
  log('  📄', title);

  // 로컬 파일명은 제목 기반(결정적) → 재캡처 시 같은 파일을 덮어쓴다.
  // 다만 분할 장수가 줄어들 수 있으므로, 이전 결과물을 먼저 지워 옛 조각이 남지 않게 한다.
  const stem = sanitize(title);
  const base = path.join(outDir, stem);
  await removeOldParts(outDir, stem);
  const files = await capturePage(page, base);
  log(`  📸 저장 ${files.length}장`);
  return { title, files };
}

// <제목>.png 과 <제목>_1.png ... 를 삭제. 정규식이 아니라 정확한 이름 비교로 안전하게.
async function removeOldParts(dir, stem) {
  const names = await fsp.readdir(dir).catch(() => []);
  for (const n of names) {
    if (!n.endsWith('.png')) continue;
    const body = n.slice(0, -4);
    if (body === stem || (body.startsWith(`${stem}_`) && /^\d+$/.test(body.slice(stem.length + 1)))) {
      await fsp.rm(path.join(dir, n), { force: true }).catch(() => {});
    }
  }
}
