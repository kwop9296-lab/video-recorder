// 진입점 — pnpm start <catalog이름> [reverse]  (catalog 하나면 이름 생략 가능)
// reverse(=--reverse|-r|desc) : catalog를 아래에서부터 녹화. 같은 catalog를 두 PC에서 위/아래로 나눠 돌릴 때 사용.
import { run } from './orchestrator.js';
import { listCatalogNames } from './core/catalog.js';

// 방향 토큰은 플래그(--reverse/-r)뿐 아니라 맨 단어(reverse/desc)도 허용 — pnpm 플래그 전달 이슈 회피.
const argv = process.argv.slice(2);
const isReverseTok = (a) => /^(--reverse|-r|reverse|desc)$/i.test(a);
const reverse = argv.some(isReverseTok);
let name = argv.find((a) => !a.startsWith('-') && !isReverseTok(a)); // 첫 비플래그·비방향 인자 = catalog 이름
const names = await listCatalogNames();

if (!name) {
  if (names.length === 1) name = names[0];
  else if (names.length === 0) { console.error('catalog 없음.  pnpm urls "<카테고리URL>" <이름>  으로 먼저 만드세요.'); process.exit(1); }
  else { console.error(`catalog 이름을 지정하세요.  있는 것: ${names.join(', ')}`); process.exit(1); }
}
if (!names.includes(name)) { console.error(`catalog '${name}' 없음.  있는 것: ${names.join(', ') || '(없음)'}`); process.exit(1); }

try {
  await run(name, { reverse });
  process.exit(0);
} catch (e) {
  console.error('실행 오류:', e.message);
  process.exit(1);
}
