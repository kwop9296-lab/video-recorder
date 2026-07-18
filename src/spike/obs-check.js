// OBS 연결/녹화 검증 스크립트.
//   pnpm obs:check         → 연결 + 버전/장면 목록만 확인
//   pnpm obs:check --rec   → 5초 테스트 녹화까지 하고 저장 경로 출력
//
// .env 의 OBS_WS_URL / OBS_WS_PASSWORD 를 사용한다.

import 'dotenv/config';
import { ObsRecorder } from '../recorder/obsRecorder.js';

const rec = new ObsRecorder({
  url: process.env.OBS_WS_URL || 'ws://127.0.0.1:4455',
  password: process.env.OBS_WS_PASSWORD || '',
});

try {
  const wsv = await rec.connect();
  console.log('✅ 연결 성공 · obs-websocket v' + wsv);

  const info = await rec.info();
  console.log('   OBS', info.obsVersion);
  console.log('   현재 장면:', info.currentScene);
  console.log('   장면 목록:', info.scenes.join(', ') || '(없음)');
  const res1080 = info.output === '1920x1080' ? '✅' : '⚠ 1920x1080 아님';
  console.log(`   해상도: 캔버스 ${info.base} / 출력 ${info.output} ${res1080} · ${info.fps}fps`);
  console.log('   지금 녹화 중?', await rec.isRecording());

  if (process.argv.includes('--rec')) {
    console.log('\n▶ 5초 테스트 녹화 시작...');
    await rec.start();
    await new Promise((r) => setTimeout(r, 5000));
    const outputPath = await rec.stop();
    console.log('■ 정지 완료. 저장 경로:\n   ' + outputPath);
    console.log('   ↑ 이 파일에 화면과 소리가 잘 담겼는지 열어서 확인하세요.');
  } else {
    console.log('\n(짧은 테스트 녹화까지 하려면:  pnpm obs:check --rec )');
  }
} catch (e) {
  console.error('❌ 실패:', e.message);
  console.error('   점검: ① OBS 실행 중? ② 도구>WebSocket 서버 설정에서 "서버 활성화" 체크?');
  console.error('        ③ .env 의 포트(4455)·비밀번호가 OBS 설정과 일치?');
} finally {
  await rec.disconnect();
  process.exit(0);
}
