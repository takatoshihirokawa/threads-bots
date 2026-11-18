// 楽天市場API（2026年の新仕様）から商品を取ってくる。
// 新仕様では applicationId と accessKey の両方が必須で、
// アプリ登録時の「許可されたWebサイト」と同じ Origin ヘッダーを付けないと 403 になる。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 楽天APIは1秒に1回程度に抑える
let lastCall = 0;
async function throttle() {
  const wait = lastCall + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
}

export async function call(endpoint, params, { origin, credentials }) {
  await throttle();
  const url = new URL(endpoint);
  const query = {
    applicationId: credentials.applicationId,
    accessKey: credentials.accessKey,
    affiliateId: credentials.affiliateId,
    format: 'json',
    formatVersion: 2,
    ...params,
  };
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
  }
  let res;
  // 混み合っているとき（429）は少し待って最大3回までやり直す
  for (let attempt = 1; ; attempt++) {
    res = await fetch(url, {
      headers: { Origin: origin, 'User-Agent': 'threads-sale-bot' },
    });
    if (res.status !== 429 || attempt >= 3) break;
    await sleep(2000 * attempt);
  }
  const body = await res.text();
  if (!res.ok) {
    throw new Error(`楽天API エラー ${res.status}: ${body.slice(0, 300)}`);
  }
  return JSON.parse(body);
}

// formatVersion=2 でも画像URLが {imageUrl} の形で返ることがあるので両方に対応する。楽天APIの画像は最大3枚
function imageUrls(item) {
  const list = item.mediumImageUrls?.length ? item.mediumImageUrls : item.smallImageUrls || [];
  return list.map((x) => (typeof x === 'string' ? x : x?.imageUrl)).filter(Boolean);
}

// 楽天の商品画像は _ex パラメータでサイズを変えられる。Threads用に大きくする。
export function largeImage(url) {
  if (!url) return null;
  const u = new URL(url);
  u.searchParams.set('_ex', '600x600');
  return u.toString();
}

export function normalize(raw) {
  const item = raw.item || raw; // formatVersion=1 の形にも対応
  return {
    itemCode: item.itemCode,
    name: item.itemName,
    price: Number(item.itemPrice),
    url: item.affiliateUrl || item.itemUrl,
    image: largeImage(imageUrls(item)[0]),
    images: [...new Set(imageUrls(item).map(largeImage))],
    reviewCount: Number(item.reviewCount || 0),
    reviewAverage: Number(item.reviewAverage || 0),
    pointRate: Number(item.pointRate || 1),
    postageIncluded: Number(item.postageFlag) === 0,
    saleStart: item.startTime || null,
    saleEnd: item.endTime || null,
    shopName: item.shopName || '',
    availability: item.availability === undefined ? 1 : Number(item.availability),
    rank: item.rank ? Number(item.rank) : null,
    caption: item.itemCaption || '',
    affiliateRate: Number(item.affiliateRate || 0),
  };
}

// sort：'standard'（楽天の標準順）や '-affiliateRate'（報酬率の高い順）
export async function searchSaleItems(genre, cfg, ctx, { sort = 'standard' } = {}) {
  const data = await call(
    cfg.search_endpoint,
    {
      genreId: genre.id,
      keyword: cfg.sale_keywords,
      orFlag: 1,
      NGKeyword: cfg.ng_keywords,
      minPrice: cfg.min_price,
      maxPrice: cfg.max_price,
      availability: 1,
      imageFlag: 1,
      hits: 30,
      sort,
    },
    ctx,
  );
  return (data.items || data.Items || []).map(normalize);
}

// 商品コード（ショップ:番号）で1商品を取り直す（B型の体験メモの商品、月末まとめの「いまの価格」用）
export async function itemByCode(itemCode, cfg, ctx) {
  const data = await call(cfg.search_endpoint, { itemCode, hits: 1 }, ctx);
  const items = (data.items || data.Items || []).map(normalize);
  return items[0] || null;
}

export async function ranking(genre, cfg, ctx) {
  const data = await call(cfg.ranking_endpoint, { genreId: genre.id }, ctx);
  return (data.items || data.Items || []).map(normalize);
}

export async function genreTree(genreId, cfg, ctx) {
  return call(cfg.genre_endpoint, { genreId }, ctx);
}
