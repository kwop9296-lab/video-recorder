// 영상 신호 감지(프로브) + 재생/화질/전체화면 제어.
// - installProbe: 페이지에 리스너를 심어 미디어 이벤트를 Node의 EventEmitter로 밀어준다.
// - VideoController: 스파이크로 검증된 동작(클릭재생 / 1080p / 전체화면 / 종료대기)을 캡슐화.

import { EventEmitter } from 'node:events';
import { log } from '../core/logger.js';

// ── 브라우저 컨텍스트(모든 프레임)에서 실행될 프로브 ──────────────────
function __installVideoProbe(selector) {
  if (window.__videoProbeInstalled) return;
  window.__videoProbeInstalled = true;
  try {
    const EVENTS = ['playing', 'pause', 'waiting', 'ended', 'error', 'durationchange', 'seeked', 'emptied', 'loadedmetadata', 'canplay'];
    const attached = new WeakSet();
    const send = (type, v) => {
      try {
        window.__videoEvent({
          type,
          t: +(v.currentTime || 0).toFixed(2),
          dur: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null,
          paused: v.paused, ended: v.ended, ready: v.readyState,
          vw: v.videoWidth, vh: v.videoHeight,
        });
      } catch (_) {}
    };
    const attach = (v) => {
      if (attached.has(v)) return;
      attached.add(v);
      EVENTS.forEach((type) => v.addEventListener(type, () => send(type, v)));
      send('attach', v);
    };
    const scan = () => { try { document.querySelectorAll('video').forEach((v) => { if (v.matches(selector)) attach(v); }); } catch (_) {} };
    const root = document.documentElement || document;
    scan();
    new MutationObserver(scan).observe(root, { childList: true, subtree: true });
  } catch (_) {}
}

// 컨텍스트에 프로브를 1회 설치하고, 정규화 이벤트를 내보내는 bus 반환.
export async function installProbe(context, selector) {
  const bus = new EventEmitter();
  bus.setMaxListeners(100);
  await context.exposeBinding('__videoEvent', (_src, ev) => bus.emit(ev.type, ev));
  await context.addInitScript(__installVideoProbe, selector);
  return bus;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class VideoController {
  constructor({ page, frame, bus, selectors, margin, maxRecordSec = 0 }) {
    this.page = page;
    this.frame = frame;
    this.bus = bus;
    this.sel = selectors;
    this.margin = margin;
    this.maxRecordSec = maxRecordSec;
  }

  loc(selector) { return this.frame.locator(selector).first(); }

  async state() {
    return this.frame.evaluate((s) => {
      const v = document.querySelector(s);
      if (!v) return null;
      return { t: v.currentTime, dur: v.duration, paused: v.paused, ended: v.ended, ready: v.readyState, vw: v.videoWidth, vh: v.videoHeight, fs: !!document.fullscreenElement };
    }, this.sel.video);
  }

  async clickCenter() {
    const box = await this.loc(this.sel.video).boundingBox({ timeout: 5000 });
    if (!box) throw new Error('video boundingBox 없음');
    await this.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }

  // 클릭으로 재생 시작 → currentTime 증가로 확인, 안 되면 재시도
  async startPlayback() {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await this.clickCenter();
      if (await this._waitAdvancing(this.timeoutPlay())) return;
      log(`  ↻ 재생 재시도(${attempt})`);
      await sleep(800);
    }
    throw new Error('재생 시작 실패 (currentTime 증가 없음)');
  }

  timeoutPlay() { return 12000; }

  async _waitAdvancing(timeout) {
    const s0 = await this.state();
    let last = s0 ? s0.t : 0;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      await sleep(700);
      const s = await this.state();
      if (s && !s.paused && s.t > last + 0.25) return true;
      if (s) last = Math.max(last, s.t);
    }
    return false;
  }

  // PrismPlayer: 톱니바퀴 → 해상도 → 1080p, videoWidth로 반영 확인
  async setQuality(label = '1080p', timeout = 15000) {
    const box = await this.loc(this.sel.video).boundingBox().catch(() => null);
    if (box) await this.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); // 컨트롤 표시
    await this.loc(this.sel.settingsButton).click({ timeout: 4000 });
    await sleep(350);
    await this.loc(this.sel.qualityHome).click({ timeout: 4000 });
    await sleep(350);
    await this.frame.locator(this.sel.qualityItem, { hasText: label }).first().click({ timeout: 4000 });

    const start = Date.now();
    while (Date.now() - start < timeout) {
      const s = await this.state();
      if (s && s.vh >= 1080) return;
      await sleep(500);
    }
    const s = await this.state();
    throw new Error(`화질 ${label} 반영 확인 실패 (현재 ${s?.vw}x${s?.vh})`);
  }

  async enterFullscreen(timeout = 6000) {
    await this.loc(this.sel.fullscreenButton).click({ timeout: 4000 });
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const s = await this.state();
      if (s && s.fs) return;
      await sleep(300);
    }
    throw new Error('전체화면 전환 확인 실패');
  }

  async exitFullscreen() {
    await this.frame.evaluate(() => { if (document.fullscreenElement) document.exitFullscreen?.(); }).catch(() => {});
  }

  async seek(t) {
    await this.frame.evaluate(([s, tt]) => { const v = document.querySelector(s); if (v) v.currentTime = tt; }, [this.sel.video, t]);
  }

  async pause() {
    const s = await this.state();
    if (s && s.paused) return;
    await this.clickCenter();
    await sleep(400);
  }

  async play() {
    const s = await this.state();
    if (s && !s.paused) return;
    await this.clickCenter();
    if (!(await this._waitAdvancing(8000))) throw new Error('재생 재개 실패');
  }

  async waitReady(timeout = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const s = await this.state();
      if (s && s.ready >= 3) return;
      await sleep(300);
    }
  }

  // ended 이벤트 대기 + 감시견(duration+margin) + 5초 폴링 백업 + 테스트 캡
  async waitForEnd(durationSec) {
    const maxMs = (durationSec || 0) * 1000 + this.margin;
    return new Promise((resolve) => {
      let done = false;
      let poll;
      let wd;
      let cap;
      const onEnded = () => finish('ended');
      const finish = (reason) => {
        if (done) return;
        done = true;
        this.bus.off('ended', onEnded);
        clearInterval(poll);
        clearTimeout(wd);
        if (cap) clearTimeout(cap);
        resolve(reason);
      };
      this.bus.on('ended', onEnded);
      poll = setInterval(async () => {
        const s = await this.state().catch(() => null);
        if (s && s.ended) finish('ended(poll)');
      }, 5000);
      wd = setTimeout(() => finish('watchdog-timeout'), maxMs);
      cap = this.maxRecordSec > 0
        ? setTimeout(() => finish(`max-cap(${this.maxRecordSec}s)`), this.maxRecordSec * 1000)
        : null;
    });
  }
}
