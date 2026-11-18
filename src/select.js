// 候補の中から、今回投稿する1商品を選ぶ。

const DAY = 24 * 60 * 60 * 1000;

// 楽天の時刻は "YYYY-MM-DD HH:MM"（日本時間）
export function parseJst(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:00+09:00`);
}

export function isRecentlyPosted(itemCode, posted, days, now) {
  return posted.some(
    (p) => p.itemCode === itemCode && now - new Date(p.postedAt) < days * DAY,
  );
}

export function score(item, now) {
  let s = 0;
  const end = parseJst(item.saleEnd);
  if (end && end > now) s += 3; // 期間限定セール中
  if (item.pointRate >= 5) s += 2;
  else if (item.pointRate >= 2) s += 1;
  if (/半額|\d+\s*%\s*OFF|\d+％OFF|クーポン/i.test(item.name)) s += 1;
  if (item.postageIncluded) s += 1;
  if (item.reviewAverage >= 4.3) s += 1;
  // 報酬率が高い商品を優先する（10%以上は大きく、4%以上は少し）
  if (item.affiliateRate >= 10) s += 3;
  else if (item.affiliateRate >= 4) s += 1;
  s += Math.min(2, Math.log10(Math.max(1, item.reviewCount)) / 2); // 0〜2
  return s;
}

// 季節外れの商品を外す。rakuten.seasonal_ng = [{ months: [10, 11, …], pattern: "日焼け止め|虫よけ" }]（日本時間の月）
export function seasonalNg(rules = [], now = new Date()) {
  const month = new Date(now.getTime() + 9 * 3600 * 1000).getUTCMonth() + 1;
  return (rules || []).filter((r) => r.months?.includes(month) && r.pattern).map((r) => new RegExp(r.pattern, 'i'));
}

export function pick(candidates, { posted, cfg, repostAfterDays, now = new Date(), random = Math.random }) {
  const seen = new Set();
  const ok = candidates.filter((it) => {
    if (!it.itemCode || seen.has(it.itemCode)) return false;
    seen.add(it.itemCode);
    if (!it.url || !it.image || !it.price) return false;
    if (it.availability !== 1) return false;
    if (it.reviewCount < cfg.min_review_count) return false;
    if (it.reviewAverage < cfg.min_review_average) return false;
    if (cfg.ng_name_pattern && new RegExp(cfg.ng_name_pattern).test(it.name)) return false;
    if (seasonalNg(cfg.seasonal_ng, now).some((re) => re.test(it.name))) return false;
    const end = parseJst(it.saleEnd);
    if (end && end - now < 60 * 60 * 1000) return false; // 1時間以内に終わるセールは紹介しない
    return !isRecentlyPosted(it.itemCode, posted, repostAfterDays, now);
  });
  if (ok.length === 0) return null;
  const ranked = ok
    .map((it) => ({ it, s: score(it, now) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 5);
  // 毎回同じ傾向にならないよう、上位5件からランダムに選ぶ
  return ranked[Math.floor(random() * ranked.length)].it;
}

// months（日本時間の月）が書いてあるジャンルは、その月だけ使う。使えるジャンルがないグループは外す
export function inSeason(groups, now = new Date()) {
  const month = new Date(now.getTime() + 9 * 3600 * 1000).getUTCMonth() + 1;
  return groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !i.months || i.months.includes(month)) }))
    .filter((g) => g.items.length > 0);
}

// 投稿回数に応じてグループを順番に回し、グループ内のジャンルも順番に回す
export function genreFor(posted, groups) {
  const group = groups[posted.length % groups.length];
  const inGroup = posted.filter((p) => p.genre === group.label).length;
  return { group, genre: group.items[inGroup % group.items.length] };
}
