// 진입점 — pnpm start <catalog이름>  (catalog 하나면 이름 생략 가능)
import { run } from './orchestrator.js';
import { listCatalogNames } from './core/catalog.js';

let name = process.argv[2];
const names = await listCatalogNames();

if (!name) {
  if (names.length === 1) name = names[0];
  else if (names.length === 0) { console.error('catalog 없음.  pnpm urls "<카테고리URL>" <이름>  으로 먼저 만드세요.'); process.exit(1); }
  else { console.error(`catalog 이름을 지정하세요.  있는 것: ${names.join(', ')}`); process.exit(1); }
}
if (!names.includes(name)) { console.error(`catalog '${name}' 없음.  있는 것: ${names.join(', ') || '(없음)'}`); process.exit(1); }

try {
  await run(name);
  process.exit(0);
} catch (e) {
  console.error('실행 오류:', e.message);
  process.exit(1);
}
