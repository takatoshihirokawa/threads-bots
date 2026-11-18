// 楽天市場のジャンル一覧を表示する（config.json のジャンル選びに使う）。
// 使い方: node src/genres.js 215783 100227   （省略時は config.json のジャンル）

import { accountDir } from './account.js';
import { readFile } from 'node:fs/promises';
import { genreTree } from './rakuten.js';

const config = JSON.parse(await readFile(new URL('config.json', accountDir()), 'utf8'));
const ctx = {
  origin: config.rakuten.origin,
  credentials: {
    applicationId: process.env.RAKUTEN_APP_ID,
    accessKey: process.env.RAKUTEN_ACCESS_KEY,
  },
};
const ids = process.argv.slice(2).filter(Boolean);
const targets = ids.length ? ids : config.genres.flatMap((g) => g.items.map((i) => i.id));

const name = (g) => g.nameJa || g.genreName;
const unwrap = (g) => g.child || g.parent || g.current || g;

for (const id of targets) {
  const data = await genreTree(id, config.rakuten, ctx);
  const current = unwrap(data.current || data.genre || {});
  console.log(`\n■ ${name(current) ?? ''}（${id}）`);
  for (const raw of data.children || []) {
    const c = unwrap(raw);
    console.log(`  ${c.genreId}\t${name(c)}`);
  }
}
