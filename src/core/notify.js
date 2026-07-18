// ntfy 푸시 알림. 한글은 헤더가 아니라 본문(UTF-8)으로 보낸다 (헤더는 ASCII만 안전).
import { config } from './config.js';
import { err } from './logger.js';

const PRI = { min: 1, low: 2, default: 3, high: 4, max: 5 };

async function post(body, { title = 'Recorder', priority = 'default' } = {}) {
  const { server, topic } = config.ntfy;
  if (!topic) return; // 알림 꺼짐
  try {
    await fetch(`${server.replace(/\/$/, '')}/${encodeURIComponent(topic)}`, {
      method: 'POST',
      body,
      headers: { Title: title, Priority: String(PRI[priority] ?? 3) },
      signal: AbortSignal.timeout(5000), // 네트워크가 죽어도 STOP 정리·종료가 막히지 않게
    });
  } catch (e) { err('ntfy 실패:', e.message); }
}

export const notifyDone = (title) => post(`✅ ${title}`, { title: 'Recorded', priority: 'default' });
export const notifyFail = (title, reason) => post(`❌ ${title}\n${reason}`, { title: 'Failed', priority: 'high' });
export const notifyLogin = () => post('🔐 네이버 재로그인 필요 (세션 만료)', { title: 'Login needed', priority: 'max' });
export const notifyStopped = (n) => post(`⏹ 중단 — 이번 세션 ${n}개 완료`, { title: 'Stopped', priority: 'default' });
