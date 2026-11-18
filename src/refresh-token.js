// Threads のトークンを更新し、新しいトークンを標準出力に出す（ログには出さない）。
// ワークフロー側で GitHub の Secret に保存し直す。

import { refreshToken } from './threads.js';

const token = process.env.THREADS_ACCESS_TOKEN;
if (!token) {
  console.error('環境変数 THREADS_ACCESS_TOKEN が設定されていません');
  process.exit(1);
}

refreshToken(token)
  .then(({ access_token, expires_in }) => {
    console.error(`トークンを更新しました（有効期限：約${Math.round(expires_in / 86400)}日）`);
    process.stdout.write(access_token);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
