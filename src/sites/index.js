// 사이트 어댑터 레지스트리 — 사이트마다 다른 것만 여기 모은다.
//   로그인 판정 / 로그인 URL / 목록 수집 / 콘텐츠 ID 규칙
// 나머지(카탈로그 병합·드라이브 완료판정·캡처·이어하기·알림)는 사이트와 무관하게 공용이다.
//
// catalog 파일에는 사이트를 따로 적지 않는다 — 항목 URL의 호스트로 판정하면 되므로
// 기존 catalog(네이버)는 아무 변환 없이 그대로 동작한다.

import naver from './naver.js';
import najuda from './najuda.js';

const SITES = [naver, najuda];
export const DEFAULT_SITE = naver; // 호스트를 못 알아보면 네이버로 (기존 동작 유지)

export const listSiteIds = () => SITES.map((s) => s.id);
export const siteById = (id) => SITES.find((s) => s.id === id) || null;

export function siteForUrl(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch (_) { return DEFAULT_SITE; }
  return SITES.find((s) => s.matchHost(host)) || DEFAULT_SITE;
}

// catalog(항목 배열)의 사이트 = 첫 항목 URL로 판정. 비어 있으면 기본값.
export function siteForItems(items) {
  const url = (items || []).find((i) => i && i.url)?.url;
  return url ? siteForUrl(url) : DEFAULT_SITE;
}
