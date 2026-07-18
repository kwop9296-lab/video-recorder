// OBS 제어 래퍼 (obs-websocket v5).
// "무엇을 찍는지"는 모른다 — 연결/녹화시작/정지/저장경로 회수만 담당한다.
// 씬 구성(창 캡처 + 오디오)은 OBS 쪽에서 사람이 미리 세팅한다.

import { OBSWebSocket } from 'obs-websocket-js';

export class ObsRecorder {
  constructor({ url = 'ws://127.0.0.1:4455', password = '' } = {}) {
    this.url = url;
    this.password = password;
    this.obs = new OBSWebSocket();
    this.connected = false;
  }

  async connect() {
    const { obsWebSocketVersion } = await this.obs.connect(this.url, this.password || undefined);
    this.connected = true;
    return obsWebSocketVersion;
  }

  async info() {
    const v = await this.obs.call('GetVersion');
    const s = await this.obs.call('GetSceneList');
    const vid = await this.obs.call('GetVideoSettings');
    return {
      obsVersion: v.obsVersion,
      currentScene: s.currentProgramSceneName,
      scenes: s.scenes.map((x) => x.sceneName),
      base: `${vid.baseWidth}x${vid.baseHeight}`,
      output: `${vid.outputWidth}x${vid.outputHeight}`,
      fps: Math.round((vid.fpsNumerator / vid.fpsDenominator) * 100) / 100,
    };
  }

  async isRecording() {
    const r = await this.obs.call('GetRecordStatus');
    return r.outputActive;
  }

  async setScene(sceneName) {
    await this.obs.call('SetCurrentProgramScene', { sceneName });
  }

  // 녹화 시작. 이미 녹화 중이면 예외(오케스트레이터가 상태를 관리해야 함).
  async start() {
    if (await this.isRecording()) throw new Error('이미 녹화 중입니다 (StartRecord 거부)');
    await this.obs.call('StartRecord');
  }

  // 실제로 녹화가 시작(outputActive)될 때까지 대기 — 인코더 워밍업 후 재생하려고 (앞부분 유실 방지)
  async waitUntilRecording(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.isRecording()) return true;
      await new Promise((r) => setTimeout(r, 200));
    }
    return false;
  }

  // 녹화 정지 → 저장된 파일 절대경로 반환.
  async stop() {
    const { outputPath } = await this.obs.call('StopRecord');
    return outputPath;
  }

  async disconnect() {
    if (this.connected) { try { await this.obs.disconnect(); } catch (_) {} }
    this.connected = false;
  }
}
