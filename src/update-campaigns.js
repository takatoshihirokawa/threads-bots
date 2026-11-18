// 楽天の公式キャンペーンページから「お買い物マラソン」「楽天スーパーセール」の開催期間を読み取り、
// config.json の campaign.periods を更新する。1日1回、GitHub Actions から動かす。
//
// ページの作りが変わって日程が読み取れなくなっても、今ある設定は消さない（追加と古い期間の削除だけ行う）。

import { listAccounts, accountDir } from './account.js';
import { readFile, writeFile } from 'node:fs/promises';

const SOURCES = [
  { name: 'お買い物マラソン', url: 'https://event.rakuten.co.jp/campaign/point-up/marathon/schedule/' },
  { name: '楽天スーパーセール', url: 'https://event.rakuten.co.jp/campaign/supersale/' },
];
const KEEP_ENDED_DAYS = 7;

const pad = (n) => String(n).padStart(2, '0');

function toText(html) {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ');
}

// 「2026年10月4日(日) 20:00 ～ 2026年10月9日(金) 01:59」の形を読み取る（終了側の年は省略されることがある）
const RANGE =
  /(\d{4})年\s*(\d{1,2})月\s*(\d{1,2})日\s*[（(][^)）]{1,3}[)）]\s*(\d{1,2}):(\d{2})\s*[～〜~ー－-]\s*(?:(\d{4})年\s*)?(\d{1,2})月\s*(\d{1,2})日\s*[（(][^)）]{1,3}[)）]\s*(\d{1,2}):(\d{2})/g;

export function parsePeriods(html, name) {
  const found = new Map();
  for (const m of toText(html).matchAll(RANGE)) {
    const [, y1, mo1, d1, h1, mi1, y2, mo2, d2, h2, mi2] = m;
    // 年をまたぐ期間（12月〜1月）で終了側の年が省略されている場合に対応
    const endYear = y2 || (Number(mo2) < Number(mo1) ? Number(y1) + 1 : y1);
    const start = `${y1}-${pad(mo1)}-${pad(d1)}T${pad(h1)}:${mi1}`;
    const end = `${endYear}-${pad(mo2)}-${pad(d2)}T${pad(h2)}:${mi2}`;
    const days = (new Date(`${end}:00+09:00`) - new Date(`${start}:00+09:00`)) / 86400000;
    if (days <= 0 || days > 14) continue; // セールらしくない長さの期間（エントリー期間など）は除く
    found.set(start, { name, start, end });
  }
  return [...found.values()];
}

export function mergePeriods(current, incoming, now = new Date()) {
  const byStart = new Map(current.map((p) => [p.start, p]));
  for (const p of incoming) {
    const existing = byStart.get(p.start);
    byStart.set(p.start, existing ? { ...existing, end: p.end } : p);
  }
  const keepAfter = now - KEEP_ENDED_DAYS * 86400000;
  return [...byStart.values()]
    .filter((p) => new Date(`${p.end}:00+09:00`) >= keepAfter)
    .sort((a, b) => a.start.localeCompare(b.start));
}

// 楽天のセール期間は全アカウント共通なので、ページは1回だけ読み、accounts/ の全アカウントの config.json に書く
async function main() {
  const incoming = [];
  for (const src of SOURCES) {
    const res = await fetch(src.url, { headers: { 'User-Agent': 'threads-sale-bot (schedule check, once a day)' } });
    if (!res.ok) throw new Error(`${src.name} のページを取得できませんでした（${res.status}）`);
    const periods = parsePeriods(await res.text(), src.name);
    console.log(`${src.name}: ${periods.length}件の期間を見つけました`);
    for (const p of periods) console.log(`  ${p.start} 〜 ${p.end}`);
    incoming.push(...periods);
  }

  for (const name of listAccounts()) {
    const path = new URL('config.json', accountDir(name));
    const config = JSON.parse(await readFile(path, 'utf8'));
    const before = JSON.stringify(config.campaign.periods);
    config.campaign.periods = mergePeriods(config.campaign.periods, incoming);
    if (JSON.stringify(config.campaign.periods) === before) {
      console.log(`${name}：セール期間の設定に変更はありません。`);
      continue;
    }
    await writeFile(path, JSON.stringify(config, null, 2) + '\n');
    console.log(`${name}：セール期間の設定を更新しました。`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
