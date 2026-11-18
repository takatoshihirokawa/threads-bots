// 投稿の型（A／B／C／D）ごとに、反応（いいね・返信・リポスト・引用）を比べる。
// Threads の threads_manage_insights 権限が必要（権限を追加したらトークンを発行し直す）。
//
// 環境変数
//   THREADS_ACCESS_TOKEN … Threads の長期アクセストークン
//   DAYS=14 … 直近何日の投稿を集計するか

import { readFile, appendFile } from 'node:fs/promises';
import { insights, accountOverview } from './threads.js';
import { accountDir } from './account.js';

const DAY = 24 * 60 * 60 * 1000;
const METRICS = ['likes', 'replies', 'reposts', 'quotes', 'views'];

// 自分で付けたリプライの数
export const selfReplies = (p) => (Array.isArray(p.replyIds) ? p.replyIds.length : p.replyId ? 1 : 0);

// 型ごとの本数・平均。template_type のない投稿（型を入れる前の投稿）は「従来型」として分けて数える
export function summarize(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = r.template_type ? `${r.template_type}${r.template_kind ? `（${r.template_kind}）` : ''}` : '従来型';
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  return [...by.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, list]) => {
      const avg = (f) => list.reduce((s, r) => s + (f(r) || 0), 0) / list.length;
      const m = Object.fromEntries(METRICS.map((k) => [k, avg((r) => r.metrics[k])]));
      return { key, count: list.length, ...m, engagement: m.likes + m.replies + m.reposts + m.quotes };
    });
}

export function toMarkdown(summary, days) {
  const f = (n) => n.toFixed(1);
  const lines = [
    `## 型ごとの反応（直近${days}日・1投稿あたりの平均）`,
    '',
    '| 型 | 本数 | エンゲージメント（いいね＋返信＋リポスト＋引用） | いいね | 返信 | リポスト | 引用 | 表示 |',
    '|---|---|---|---|---|---|---|---|',
    ...summary.map((s) => `| ${s.key} | ${s.count} | ${f(s.engagement)} | ${f(s.likes)} | ${f(s.replies)} | ${f(s.reposts)} | ${f(s.quotes)} | ${f(s.views)} |`),
    '',
    '従来型（型を入れる前の投稿）は比べるときに混ぜないでください。1つの型が3〜5本以上たまってから比べるのがおすすめです。',
  ];
  return lines.join('\n');
}

async function main() {
  const token = process.env.THREADS_ACCESS_TOKEN;
  if (!token) throw new Error('環境変数 THREADS_ACCESS_TOKEN が設定されていません');
  const days = Number(process.env.DAYS || 14);
  const posted = JSON.parse(await readFile(new URL('data/posted.json', accountDir()), 'utf8'));
  const since = Date.now() - days * DAY;
  const rows = [];
  for (const p of posted.filter((r) => r.threadsId && new Date(r.postedAt) >= since)) {
    try {
      const metrics = await insights(p.threadsId, token);
      // 返信の数には、自分で付けたリンクのリプライ（A・B型は1件、月末まとめは商品の数）も入っているので引く
      metrics.replies = Math.max(0, (metrics.replies || 0) - selfReplies(p));
      rows.push({ ...p, metrics });
    } catch (e) {
      if (/permission|insights|#10\b|"code":10/i.test(e.message)) {
        throw new Error(`反応の数を読む権限がありません。Meta for Developers で threads_manage_insights を追加して、トークンを発行し直してください：${e.message}`);
      }
      console.log(`${p.permalink} の数を読めませんでした：${e.message}`);
    }
  }
  let md = toMarkdown(summarize(rows), days);
  // アカウント全体（表示されているかの切り分け用）
  try {
    const { profile, metrics } = await accountOverview(token, Math.min(days, 30));
    md += `\n\n## アカウント全体（直近${Math.min(days, 30)}日）\n- @${profile.username}（認証：${profile.is_verified ? 'あり' : 'なし'}）\n- 表示 ${metrics.views ?? '-'}／いいね ${metrics.likes ?? '-'}／返信 ${metrics.replies ?? '-'}／リポスト ${metrics.reposts ?? '-'}／引用 ${metrics.quotes ?? '-'}／フォロワー ${metrics.followers_count ?? '-'}`;
  } catch (e) {
    md += `\n\nアカウント全体の数値を読めませんでした：${e.message.slice(0, 200)}`;
  }
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
