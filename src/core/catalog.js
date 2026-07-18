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

// 병합: 기존 항목 유지 + 새 항목 추가(id union). 제목은 최신값 보강, skip(영상없음)은 보존.
export async function mergeCatalog(name, incoming) {
  const cur = await loadCatalog(name);
  const byId = new Map(cur.map((e) => [e.id, e]));
  for (const it of incoming) {
    const prev = byId.get(it.id);
    byId.set(it.id, prev ? { ...prev, title: it.title || prev.title, url: it.url || prev.url, skip: prev.skip || it.skip } : it);
  }
  const merged = [...byId.values()];
  await saveCatalog(name, merged);
  return merged;
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
