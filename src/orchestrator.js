// 지휘자 — catalog(작업 큐)의 미완료 항목을 순회하며 녹화 → 드라이브 업로드 → 로컬삭제.
// 완료 기준은 "드라이브에 그 콘텐츠 파일이 있음". STOP은 항상 녹화 도중에 일어나므로,
// 진행 중인 항목은 완료로 치지 않고 버린다(다음에 재녹화).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './core/config.js';
import { log, err } from './core/logger.js';
import { launchSession, ensureLoggedIn, isLoggedIn } from './browser/session.js';
import { openContent, getContentTitle } from './browser/navigator.js';
import { installProbe, VideoController } from './browser/videoProbe.js';
import { ObsRecorder } from './recorder/obsRecorder.js';
import { DriveClient, md5OfFile } from './drive/driveClient.js';
import { loadCatalog, setSkip } from './core/catalog.js';
import { notifyDone, notifyFail, notifyLogin, notifyStopped } from './core/notify.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run(catalogName, { reverse = false } = {}) {
  if (!config.drive.rootFolder) throw new Error('GDRIVE_ROOT 미설정 — .env 에 GDRIVE_ROOT 를 지정하세요.');
  const items = await loadCatalog(catalogName);
  if (!items.length) { log(`catalog '${catalogName}' 이 비어있음. 먼저 pnpm urls 로 채우세요.`); return; }

  await fsp.mkdir(config.recordDir, { recursive: true });

  // 드라이브: 루트/카탈로그 폴더 보장 + 완료된 콘텐츠 ID 목록
  log('☁ 드라이브 연결...');
  const drive = new DriveClient();
  const rootId = await drive.ensureFolder(config.drive.rootFolder);
  const folderId = await drive.ensureFolder(catalogName, rootId);
  // 완료 기준 = Drive에 그 콘텐츠 파일 존재. (로컬 파일 유무는 무관 — 로컬은 그냥 덮어쓰는 사본)
  const doneIds = new Set((await drive.listFiles(folderId)).map((f) => f.appProperties?.contentId).filter(Boolean));

  const novideoN = items.filter((i) => i.skip === 'novideo').length;
  const todo = config.force
    ? items.filter((i) => i.skip !== 'novideo')
    : items.filter((i) => !doneIds.has(i.id) && i.skip !== 'novideo');
  // 아래에서부터 녹화(두 PC로 위/아래 분담 시). 완료 필터는 그대로, 순회 방향만 뒤집는다.
  if (reverse) todo.reverse();
  log(`📋 '${catalogName}': 총 ${items.length} · 완료 ${doneIds.size} · 영상없음 ${novideoN} · 남음 ${todo.length}${config.force ? ' · [FORCE]' : ''}${reverse ? ' · [역순]' : ''}`);
  if (!todo.length) { log('할 일 없음.'); return; }

  const context = await launchSession();
  const bus = await installProbe(context, config.selectors.video);
  if (!(await isLoggedIn(context))) await notifyLogin();
  await ensureLoggedIn(context);

  const obs = new ObsRecorder(config.obs);
  await obs.connect();
  const info = await obs.info();
  log(`🎬 OBS · 출력 ${info.output} · ${info.fps}fps · 장면 "${info.currentScene}"`);
  if (config.obs.scene && config.obs.scene !== info.currentScene) await obs.setScene(config.obs.scene);

  const page = context.pages()[0] || (await context.newPage());
  let doneThisSession = 0;
  let stopping = false;

  // STOP(Ctrl+C): 진행 중 녹화 폐기 + 정리 + 알림.
  // 알림을 정리보다 "먼저" 보낸다 — context.close()가 느리거나 멈춰도 STOP 알림은 확실히 나가게.
  // once가 아니라 on + 가드: 두 번째 Ctrl+C는 무시하고 정리를 끝까지 진행(중복 신호로 인한 강제 종료 방지).
  process.on('SIGINT', async () => {
    if (stopping) return;
    stopping = true;
    err('\n⛔ STOP — 진행 중 녹화 폐기 & 정리 중...');
    await notifyStopped(doneThisSession);
    try { if (await obs.isRecording()) await obs.stop(); } catch (_) {}
    try { await obs.disconnect(); } catch (_) {}
    try { await context.close(); } catch (_) {}
    process.exit(130);
  });

  for (const [i, v] of todo.entries()) {
    if (stopping) break;
    // 항목별 재확인 — 다른 PC(반대 방향)가 방금 올렸으면 스킵. 위/아래가 중간에서 만나도 중복 녹화 방지.
    if (!config.force && await drive.findByContentId(folderId, v.id)) {
      doneIds.add(v.id);
      log(`[${i + 1}/${todo.length}] ⏭ 이미 완료(다른 PC) — ${v.title || v.url}`);
      continue;
    }
    log(`\n[${i + 1}/${todo.length}] ${v.title || v.url}`);
    try {
      const r = await recordOne(page, bus, obs, v);
      if (r === 'novideo') {
        await setSkip(catalogName, v.id, 'novideo');
        log('  ⏭ 영상 없음 → catalog에 기록(다음엔 스킵)');
        continue;
      }
      log('  ☁ 업로드...');
      const up = await drive.uploadFile({ folderId, name: sanitize(r.title) + '.mkv', filePath: r.localPath, contentId: v.id });
      const localMd5 = await md5OfFile(r.localPath);
      if (up.md5Checksum && up.md5Checksum !== localMd5) {
        await drive.deleteFile(up.id).catch(() => {});
        throw new Error('업로드 무결성 불일치(md5) — 재시도 대상');
      }
      // 로컬 파일은 유지(삭제 안 함). 완료 기준은 Drive.
      doneIds.add(v.id);
      doneThisSession++;
      log('  ✅ 완료·업로드:', r.title, '(로컬 보관)');
      await notifyDone(r.title);
    } catch (e) {
      err('  ❌ 실패:', e.message);
      await notifyFail(v.title || v.id, e.message);
      try { if (await obs.isRecording()) await obs.stop(); } catch (_) {}
    }
  }

  await obs.disconnect();
  await context.close();
  log(`\n세션 종료 — 이번에 ${doneThisSession}개 완료.`);
  return { doneThisSession };
}

// 한 항목 녹화 → 'novideo' | { localPath, title }
async function recordOne(page, bus, obs, v) {
  const frame = await openContent(page, v.url, {
    selector: config.selectors.video,
    timeout: config.timeouts.playerAppear,
    requireVideo: false,
  });
  if (!frame) return 'novideo';

  const vc = new VideoController({
    page, frame, bus,
    selectors: config.selectors,
    margin: config.timeouts.endWatchdogMargin,
    maxRecordSec: config.maxRecordSec,
  });

  const title = v.title || (await getContentTitle(frame)) || v.id;
  log('  📄', title);

  await vc.startPlayback();               log('  ▶ 재생');
  await vc.setQuality(config.quality);    log('  ⚙ 1080p');
  await vc.enterFullscreen();             log('  ⛶ 전체화면');

  const duration = (await vc.state())?.dur || 0;

  // 처음부터 온전히: 0초 되감고, OBS 시작이 "실제로 active" 된 뒤 재생 (앞부분 유실 방지)
  await vc.pause();
  await vc.seek(0);
  await vc.waitReady();
  await obs.start();
  if (!(await obs.waitUntilRecording(config.timeouts.obsStartConfirm))) throw new Error('OBS 녹화 시작 확인 실패');
  await sleep(500);
  log(`  ● 녹화 시작 (예상 ${fmtDur(duration)})`);
  await vc.play();

  const reason = await vc.waitForEnd(duration);
  await sleep(config.timeouts.tailDelay); // 끝 여유(짤림 방지)
  const outputPath = await obs.stop();
  await vc.exitFullscreen();

  // 정상 종료(ended)나 테스트 캡만 완료 인정. watchdog 등 이상종료는 폐기.
  if (!/ended|max-cap/.test(reason)) {
    await fsp.rm(outputPath, { force: true }).catch(() => {});
    throw new Error(`비정상 종료(${reason}) — 폐기`);
  }
  log('  ■ 종료:', reason);

  // 로컬 파일명은 제목 기반(결정적) → 재녹화 시 같은 파일을 덮어씀. 로컬은 계속 보관.
  const dest = path.join(config.recordDir, `${sanitize(title)}.mkv`);
  await moveFile(outputPath, dest);
  return { localPath: dest, title };
}

function sanitize(name) { return String(name).replace(/[<>:"/\\|?*\n\r\t]+/g, '_').replace(/\.+$/, '').trim().slice(0, 90) || 'video'; }
function fmtDur(sec) { const m = Math.floor(sec / 60), s = Math.round(sec % 60); return `${m}분 ${s}초`; }

async function moveFile(src, dest) {
  await fsp.rm(dest, { force: true }).catch(() => {});
  try { await fsp.rename(src, dest); }
  catch (_) { await fsp.copyFile(src, dest); await fsp.unlink(src).catch(() => {}); }
}
