// OBS 설정용 — REC-AUTOMATION 창을 1080p 전체화면으로 재생만 하고 대기(녹화 X).
// 이 창을 상대로 OBS 윈도우 캡처/오디오 캡처를 느긋하게 설정한 뒤 Ctrl+C.
//
//   pnpm setup:window "<영상URL>"    (URL 생략 시 .env TARGET_URL 또는 videos.json[0])

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../core/config.js';
import { launchSession, ensureLoggedIn } from '../browser/session.js';
import { openContent } from '../browser/navigator.js';
import { installProbe, VideoController } from '../browser/videoProbe.js';

let url = process.argv[2] || process.env.TARGET_URL;
if (!url) {
  try { url = JSON.parse(await fs.readFile(path.join(config.root, 'data', 'videos.json'), 'utf8'))[0]?.url; } catch (_) {}
}
if (!url || /여기에/.test(url)) {
  console.error('URL이 없습니다.  pnpm setup:window "<영상URL>"  로 넣거나 data/videos.json 을 채우세요.');
  process.exit(1);
}

const context = await launchSession();
const bus = await installProbe(context, config.selectors.video);
await ensureLoggedIn(context);

const page = context.pages()[0];
const frame = await openContent(page, url, { selector: config.selectors.video, timeout: config.timeouts.playerAppear });
const vc = new VideoController({ page, frame, bus, selectors: config.selectors, margin: 0 });

await vc.startPlayback();
await vc.setQuality(config.quality);
await vc.enterFullscreen();

console.log(`
✅ "${config.windowTitle}" 창이 1080p 전체화면으로 재생 중입니다.
   지금 OBS에서 아래처럼 설정하세요 (Alt+Tab 으로 OBS 열기):

   [윈도우 캡처]
     - 캡처 방법(Capture Method): Windows Graphics Capture
     - 윈도우: [chrome.exe]: ${config.windowTitle} ...
     - 창 일치 우선순위: "창 제목이 일치해야 함"
     - 소스 우클릭 → 변형 → 화면에 맞추기 (Ctrl+F)

   [응용 프로그램 오디오 캡처]
     - 윈도우: 위와 같은 ${config.windowTitle} 창 선택 (개인 크롬 소리 분리 목적)

   설정/미리보기 확인이 끝나면 이 터미널에서 Ctrl+C.
`);

await new Promise(() => {}); // 계속 대기
