// どのアカウントの設定・記録を使うかを決める。アカウントごとのファイルは accounts/<名前>/ にある。
//   accounts/<名前>/config.json … キャラ・ジャンル・投稿時間などの設定
//   accounts/<名前>/data/        … 投稿の記録（posted.json）と、人が書くデータ（体験メモ・写真・セール予定）
// 環境変数 ACCOUNT で指定する（例：ACCOUNT=neko）。

import { readdirSync } from 'node:fs';

export const ROOT = new URL('..', import.meta.url);
const ACCOUNTS_DIR = new URL('accounts/', ROOT);

export const listAccounts = () =>
  readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

export function accountName(name = process.env.ACCOUNT) {
  const all = listAccounts();
  if (!name) throw new Error(`環境変数 ACCOUNT でアカウントを指定してください（${all.join(' / ')}）`);
  if (!all.includes(name)) throw new Error(`アカウント「${name}」は accounts/ にありません（${all.join(' / ')}）`);
  return name;
}

// accounts/<名前>/ の URL（末尾は /）
export const accountDir = (name = accountName()) => new URL(`${name}/`, ACCOUNTS_DIR);
