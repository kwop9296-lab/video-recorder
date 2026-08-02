// 종류별 catalog (작업 큐) — data/catalogs/<name>.json = [{ id, title, url, skip? }]
// 완료 여부는 여기 저장하지 않는다(Drive가 기준). 그래서 재생성/병합해도 진행상황이 안 날아간다.

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const DIR = path.join(config.root, 'data', 'catalogs');
export const catalogPath = (name) => path.join(DIR, `${name}.json`);

// URL 끝의 콘텐츠 ID (쿼리 붙어도 안전)
export function contentId(url) {
  try { return new URL(url).pathname.split('/').filter(Boolean).pop() || url; }
  catch (_) { return url; }
}

export async function loadCatalog(name) {
  try { return JSON.parse(await fs.readFile(catalogPath(name), 'utf8')); }
  catch (_) { return []; }
}

export async function saveCatalog(name, list) {
  await fs.mkdir(DIR, { recursive: true });
  await fs.writeFile(catalogPath(name), JSON.stringify(list, null, 2) + '\n');
}

// 병합: 기존 항목 유지 + 새 항목 추가(id union). 제목은 최신값 보강, skip(영상없음)·done은 보존.
// 순서는 incoming(사이트 목록 순서 = 최신이 위) 기준으로 매번 다시 잡는다.
//   → 새로 올라온 콘텐츠가 catalog 맨 위에 오고, pnpm start/shot 도 최신부터 처리한다.
// 이번 수집에 안 잡힌 기존 항목(비공개 전환·스크롤 밖 등)은 버리지 않고 원래 순서로 뒤에 남긴다.
// 반환: { merged, added } — added 는 이번에 처음 들어온 항목(신규 표시용).
export async function mergeCatalog(name, incoming) {
  const cur = await loadCatalog(name);
  const byId = new Map(cur.map((e) => [e.id, e]));
  const seen = new Set();
  const head = [];
  const added = [];
  for (const it of incoming) {
    if (seen.has(it.id)) continue; // 목록에 중복 노출된 카드 방어
    seen.add(it.id);
    const prev = byId.get(it.id);
    if (!prev) { head.push(it); added.push(it); continue; }
    head.push({ ...prev, title: it.title || prev.title, url: it.url || prev.url });
  }
  const merged = [...head, ...cur.filter((e) => !seen.has(e.id))];
  await saveCatalog(name, merged);
  return { merged, added };
}

export async function setSkip(name, id, skip) {
  const cur = await loadCatalog(name);
  const e = cur.find((x) => x.id === id);
  if (e) { e.skip = skip; await saveCatalog(name, cur); }
}

export async function listCatalogNames() {
  try {
    return (await fs.readdir(DIR)).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
  } catch (_) { return []; }
}
