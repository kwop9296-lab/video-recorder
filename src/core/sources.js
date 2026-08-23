// catalog 이름 → 카테고리 목록 URL 매핑 (data/sources.json)
//   { "hong": "https://.../contents?categoryId=...", ... }
// URL로 한 번 실행하면 자동 등록되고, 이후엔 `pnpm urls hong` 처럼 이름만으로 갱신할 수 있다.
// data/ 는 .gitignore 대상이라 이 파일은 PC별 로컬 설정이다(커밋 안 됨).

import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

const FILE = path.join(config.root, 'data', 'sources.json');
export const sourcesPath = () => FILE;

export async function loadSources() {
  try {
    const obj = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) { return {}; }
}

export async function getSource(name) {
  return (await loadSources())[name] || null;
}

// 등록/갱신. 같은 이름을 다른 URL로 다시 돌리면 새 URL로 덮어쓴다(카테고리 이전 대응).
export async function setSource(name, url) {
  const cur = await loadSources();
  if (cur[name] === url) return false;
  cur[name] = url;
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(cur, null, 2) + '\n');
  return true;
}
