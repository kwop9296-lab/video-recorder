// catalog 이름 → { 목록 URL, 계정 } 매핑 (data/sources.json)
//   { "hong": "https://.../contents?categoryId=...",              ← 기본 계정 (예전 형식 그대로)
//     "drmroad": { "url": "https://najuda.com/...", "account": "sub" } }  ← 두 번째 아이디
// URL로 한 번 실행하면 자동 등록되고, 이후엔 `pnpm urls hong` 처럼 이름만으로 갱신할 수 있다.
// 계정을 적어두면 그 catalog를 건드리는 모든 명령(urls/shot/start/login)이 그 프로필을 쓴다
// — 탭마다 다른 아이디를 쓸 때 매번 손으로 지정하지 않아도 되고, 잘못 조합할 일도 없다.
// data/ 는 .gitignore 대상이라 이 파일은 PC별 로컬 설정이다(커밋 안 됨).

import fs from 'node:fs/promises';
import path from 'node:path';
import { config, normalizeAccount } from './config.js';

const FILE = path.join(config.root, 'data', 'sources.json');
export const sourcesPath = () => FILE;

// 저장 형식은 두 가지 — 문자열(기본 계정)과 객체. 읽을 땐 항상 객체로 맞춘다.
const normalize = (v) =>
  typeof v === 'string'
    ? { url: v, account: '' }
    : { url: v?.url || '', account: normalizeAccount(v?.account) };

async function readRaw() {
  try {
    const obj = JSON.parse(await fs.readFile(FILE, 'utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {};
  } catch (_) { return {}; }
}

export async function loadSources() {
  return Object.fromEntries(Object.entries(await readRaw()).map(([k, v]) => [k, normalize(v)]));
}

export async function getSource(name) {
  return (await loadSources())[name] || null;
}

// 등록/갱신. 같은 이름을 다른 URL로 다시 돌리면 새 URL로 덮어쓴다(카테고리 이전 대응).
// 계정을 주지 않으면 이미 등록된 계정을 유지한다 — `pnpm urls drmroad` 로 갱신할 때
// --account 를 다시 안 적어도 되게.
export async function setSource(name, url, account = null) {
  const raw = await readRaw();
  const cur = normalize(raw[name]);
  const acc = account === null ? cur.account : normalizeAccount(account);
  if (cur.url === url && cur.account === acc) return false;
  raw[name] = acc ? { url, account: acc } : url; // 기본 계정이면 예전처럼 문자열로 (파일 깔끔하게)
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(raw, null, 2) + '\n');
  return true;
}

// 이 catalog를 어느 계정으로 돌릴지.
// 우선순위: 명령줄 --account  >  환경변수 PROFILE  >  sources.json 에 기록된 값  >  기본 계정
export async function resolveAccount(catalogName, override = '') {
  const explicit = normalizeAccount(override) || normalizeAccount(process.env.PROFILE);
  if (explicit) return explicit;
  return (await loadSources())[catalogName]?.account || '';
}

// 명령줄에서 --account=<이름> 뽑아내기.
// 공백형(--account sub)은 받지 않는다 — catalog 이름과 헷갈리기 때문.
export function accountFromArgv(argv = process.argv.slice(2)) {
  const eq = argv.find((a) => /^--account=/.test(a));
  return eq ? normalizeAccount(eq.slice('--account='.length)) : '';
}
