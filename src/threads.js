// Threads API で投稿する。
// 流れ：コンテナを作る → 処理が終わるのを待つ → 公開する

const API = 'https://graph.threads.net/v1.0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class ThreadsError extends Error {
  constructor(message, { status, retryable }) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

async function callOnce(method, path, params, token) {
  const url = new URL(`${API}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: token });
  let res;
  try {
    res = method === 'GET' ? await fetch(`${url}?${body}`) : await fetch(url, { method, body });
  } catch (e) {
    throw new ThreadsError(`Threads API に接続できません (${path}): ${e.message}`, { status: 0, retryable: true });
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) {
    const retryable = res.status === 429 || res.status >= 500 || json.error?.is_transient === true;
    throw new ThreadsError(`Threads API エラー (${path}): ${JSON.stringify(json.error || json).slice(0, 300)}`, {
      status: res.status,
      retryable,
    });
  }
  return json;
}

// 一時的なエラー（混雑・サーバー側の不調）は待ってやり直す。
// 公開（threads_publish）は二重投稿を避けるため、接続エラー時はやり直さない。
async function call(method, path, params, token, { retryOnNetwork = true } = {}) {
  const waits = [5000, 15000, 45000];
  for (let attempt = 0; ; attempt++) {
    try {
      return await callOnce(method, path, params, token);
    } catch (e) {
      const canRetry = e.retryable && (retryOnNetwork || e.status !== 0) && attempt < waits.length;
      if (!canRetry) throw e;
      console.log(`${e.message} → ${waits[attempt] / 1000}秒後にやり直します`);
      await sleep(waits[attempt]);
    }
  }
}

async function waitReady(id, token) {
  for (let i = 0; i < 30; i++) {
    const { status, error_message } = await call('GET', id, { fields: 'status,error_message' }, token);
    if (status === 'FINISHED') return;
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new ThreadsError(`コンテナ ${id} が ${status} になりました ${error_message || ''}`, {
        status: 0,
        retryable: false,
      });
    }
    await sleep(5000);
  }
  throw new ThreadsError(`コンテナ ${id} の処理がタイムアウトしました`, { status: 0, retryable: false });
}

async function publish(userId, params, token) {
  const { id: creationId } = await call('POST', `${userId}/threads`, params, token);
  await waitReady(creationId, token);
  const { id } = await call('POST', `${userId}/threads_publish`, { creation_id: creationId }, token, {
    retryOnNetwork: false,
  });
  const { permalink } = await call('GET', id, { fields: 'permalink' }, token);
  return { id, permalink };
}

// 親投稿：商品画像付き。画像が2枚以上ならカルーセル（横にスワイプできる複数枚）にして滞在時間を延ばす。
// 失敗したら1枚だけ → テキストだけ、の順に切り替えて投稿する。
// 公開で「Media Not Found」（Threads 側の一時的な不調）が返ったときは、切り替える前に、待って同じ形で作り直す
// （2026-11-06 に kaden で2回続けて起き、画像なしの投稿になった。2026-11-09 Muse の提案 P04）。
// textOnly：画像が付けられなかったとき、テキストだけで投稿するか。false なら NoImageError を投げて投稿しない
// （商品紹介は画像なしだと商品が伝わらないため。2026-11-16 Muse の提案 P01）
export class NoImageError extends Error {}

export async function publishParent(
  { userId = 'me', text, imageUrls = [], token, textOnly = true },
  { wait = sleep, retryWaits = [30000, 90000] } = {},
) {
  const again = (attempt) => retryOnMediaNotFound(attempt, { userId, text, token, wait, retryWaits });
  if (imageUrls.length >= 2) {
    try {
      return await again(async () => {
        const children = [];
        for (const url of imageUrls.slice(0, 20)) {
          const { id } = await call('POST', `${userId}/threads`, { media_type: 'IMAGE', image_url: url, is_carousel_item: 'true' }, token);
          children.push(id);
        }
        for (const id of children) await waitReady(id, token);
        const post = await publish(userId, { media_type: 'CAROUSEL', children: children.join(','), text }, token);
        return { ...post, mediaCount: children.length };
      });
    } catch (e) {
      if (e.retryable) throw e;
      console.log(`複数枚の投稿に失敗したため、1枚で投稿します：${e.message}`);
    }
  }
  if (imageUrls[0]) {
    try {
      return await again(async () => ({ ...(await publish(userId, { media_type: 'IMAGE', image_url: imageUrls[0], text }, token)), mediaCount: 1 }));
    } catch (e) {
      if (e.retryable) throw e;
      console.log(`画像付きの投稿に失敗したため、テキストだけで投稿します：${e.message}`);
    }
  }
  if (imageUrls.length && !textOnly) throw new NoImageError('画像を付けられなかったため、この商品の投稿は見送ります');
  return again(async () => ({ ...(await publish(userId, { media_type: 'TEXT', text }, token)), mediaCount: 0 }));
}

// 「Media Not Found」のときだけ、待ってからやり直す（30秒後・さらに90秒後の最大2回）。
// やり直す前に、同じ本文の投稿がもう出ていないか確かめる（二重投稿を防ぐ）
export async function retryOnMediaNotFound(attempt, { userId = 'me', text, token, wait = sleep, retryWaits = [30000, 90000], find = findOwnPost }) {
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (e) {
      if (!isMediaNotFound(e) || i >= retryWaits.length) throw e;
      console.log(`${e.message.slice(0, 200)} → ${retryWaits[i] / 1000}秒待って、同じ形で作り直します（${i + 1}回目）`);
      await wait(retryWaits[i]);
      const existing = await find(text, token, userId).catch(() => null);
      if (existing) {
        console.log('実は公開できていたので、作り直しません');
        return { ...existing, mediaCount: existing.mediaCount ?? null };
      }
    }
  }
}

// 自分の最近の投稿に、同じ本文のものがあれば返す（エラーでも実は公開できていた場合の二重投稿を防ぐ）
async function findOwnPost(text, token, userId = 'me') {
  const { data = [] } = await call('GET', `${userId}/threads`, { fields: 'id,text,permalink,media_type', limit: '10' }, token);
  const hit = data.find((p) => (p.text || '').trim() === String(text).trim());
  return hit ? { id: hit.id, permalink: hit.permalink, mediaCount: hit.media_type === 'TEXT_POST' ? 0 : null } : null;
}

// 公開のときに「Media Not Found」（作ったばかりのコンテナが見つからない）が返ることがある。
// Threads 側の一時的な不調なので、少し待ってからコンテナを作り直す。
export const isMediaNotFound = (e) => /threads_publish/.test(e?.message || '') && /4279009|Media Not Found/.test(e?.message || '');

// 親投稿に、同じ文のリプライがもう付いていないか確かめる（エラーでも実は公開できていた場合の二重投稿を防ぐ）
async function findReply(parentId, text, token) {
  const { data = [] } = await call('GET', `${parentId}/replies`, { fields: 'id,text,permalink' }, token);
  const hit = data.find((r) => (r.text || '').trim() === text.trim());
  return hit ? { id: hit.id, permalink: hit.permalink } : null;
}

// リプライ：親投稿にぶら下げる。リンクはカードで表示する（threads_manage_replies 権限が必要）。
export async function publishReply({ userId = 'me', parentId, text, link, token, retryWait = 30000 }) {
  const params = { media_type: 'TEXT', text, reply_to_id: parentId, ...(link ? { link_attachment: link } : {}) };
  try {
    return await publish(userId, params, token);
  } catch (e) {
    if (!isMediaNotFound(e)) throw e;
    console.log(`${e.message} → ${retryWait / 1000}秒待って、リプライを作り直します`);
    await sleep(retryWait);
    const existing = await findReply(parentId, text, token).catch(() => null);
    if (existing) return existing;
    return publish(userId, params, token);
  }
}

// 長期トークンの有効期限（60日）を延ばす。発行から24時間以上たったトークンのみ更新できる。
export async function refreshToken(token) {
  const url = `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  if (!res.ok || !json.access_token) {
    throw new Error(`トークン更新エラー: ${JSON.stringify(json.error || json).slice(0, 300)}`);
  }
  return json;
}

// アカウント全体の数値（直近の表示数・フォロワー数など）とプロフィール。投稿が表示されているかの切り分けに使う
// （2026-11-09 Muse の提案 P01：sale_neko の投稿がほぼ表示されていない）。threads_manage_insights 権限が必要
export async function accountOverview(token, days = 7) {
  const since = Math.floor((Date.now() - days * 86400000) / 1000);
  const until = Math.floor(Date.now() / 1000);
  const profile = await call('GET', 'me', { fields: 'username,name,is_verified,threads_biography' }, token);
  const { data = [] } = await call('GET', 'me/threads_insights', { metric: 'views,likes,replies,reposts,quotes,followers_count', since: String(since), until: String(until) }, token);
  const metrics = Object.fromEntries(data.map((m) => [m.name, m.total_value?.value ?? (m.values || []).reduce((a, v) => a + (v.value || 0), 0)]));
  return { profile, metrics };
}

// 投稿ごとの反応（表示・いいね・返信・リポスト・引用）。threads_manage_insights 権限が必要
export async function insights(mediaId, token) {
  const { data = [] } = await call('GET', `${mediaId}/insights`, { metric: 'views,likes,replies,reposts,quotes' }, token);
  return Object.fromEntries(data.map((m) => [m.name, m.values?.[0]?.value ?? m.total_value?.value ?? 0]));
}
