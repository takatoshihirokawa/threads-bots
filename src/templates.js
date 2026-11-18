// 投稿の型（テンプレート）を選び、型ごとの決まった部分を組み立てる。
//   A：セール速報型   … 1行目にセール名と数字（価格・ポイント倍率）、2行目に商品と価格。リンクはリプライ
//   B：実体験レビュー型 … data/experiences.json の体験メモ（人が書いたもの）がある商品だけ。体験談は作らない
//   C：まとめ型       … 月初「今月のセールカレンダー」、月末「今月紹介した中で評価の高かったもの」
//   D：質問型         … data/desk_photos.json のデスク写真＋「あと何かいるかな？」の相談投稿
// どの型を何本に1回にするかは config.json の templates に書く。

import { parseJst } from './select.js';
import { cleanName } from './compose.js';

const DAY = 24 * 60 * 60 * 1000;
const yen = (n) => Number(n).toLocaleString('ja-JP');
const jst = (d) => new Date(new Date(d).getTime() + 9 * 3600 * 1000);
const jstMonth = (d) => jst(d).toISOString().slice(0, 7);

// 日本時間の「M/D H:MM」
export function formatJst(d) {
  const j = jst(d);
  return `${j.getUTCMonth() + 1}/${j.getUTCDate()} ${j.getUTCHours()}:${String(j.getUTCMinutes()).padStart(2, '0')}`;
}

const isLastDayOfMonth = (now) => jst(now.getTime() + DAY).getUTCDate() === 1;

// 前回その型を投稿してから、何本ほかの投稿をしたか（一度も投稿していなければ Infinity）
export function postsSince(posted, type) {
  for (let i = posted.length - 1; i >= 0; i--) {
    if (posted[i].template_type === type) return posted.length - 1 - i;
  }
  return Infinity;
}

const postedThisMonth = (posted, type, kind, now) =>
  posted.some((p) => p.template_type === type && p.template_kind === kind && jstMonth(p.postedAt) === jstMonth(now));

// 今月 A・B 型で紹介した商品（重複なし・新しい順）
export function itemsThisMonth(posted, now) {
  const seen = new Set();
  return posted
    .filter((p) => p.itemCode && ['A', 'B', undefined].includes(p.template_type) && jstMonth(p.postedAt) === jstMonth(now))
    .reverse()
    .filter((p) => !seen.has(p.itemCode) && seen.add(p.itemCode));
}

// 体験メモのうち、まだ（または repost_after_days 以上）投稿していないもの
export function freshExperiences(experiences, posted, days, now) {
  return (experiences || []).filter(
    (e) => e.itemCode && !posted.some((p) => p.template_type === 'B' && p.itemCode === e.itemCode && now - new Date(p.postedAt) < days * DAY),
  );
}

// 今回の投稿の型を決める。{ type: 'A'|'B'|'C'|'D', kind?, experience?, photo? }
export function chooseTemplate({ posted, templates = {}, now = new Date(), experiences = [], photos = [], repostAfterDays = 30 }) {
  const t = templates;
  const forced = process.env.TEMPLATE;
  if (t.C?.enabled !== false && (forced === 'C-calendar' || (!forced && jst(now).getUTCDate() === (t.C?.calendar_day ?? 1) && !postedThisMonth(posted, 'C', 'calendar', now)))) {
    return { type: 'C', kind: 'calendar' };
  }
  const topMin = t.C?.top_min ?? 3;
  if (t.C?.enabled !== false && (forced === 'C-top' || (!forced && isLastDayOfMonth(now) && !postedThisMonth(posted, 'C', 'top', now) && itemsThisMonth(posted, now).length >= topMin))) {
    return { type: 'C', kind: 'top' };
  }
  if (t.D?.enabled && photos.length && (forced === 'D' || (!forced && postsSince(posted, 'D') >= (t.D.every ?? 5) - 1))) {
    // 一番長く使っていない写真から順に使う
    const lastUsed = (ph) => Math.max(-1, ...posted.filter((p) => p.photo === ph.image_url).map((p) => new Date(p.postedAt).getTime()));
    const photo = [...photos].sort((a, b) => lastUsed(a) - lastUsed(b))[0];
    return { type: 'D', photo };
  }
  const fresh = freshExperiences(experiences, posted, repostAfterDays, now);
  if (t.B?.enabled !== false && fresh.length && (forced === 'B' || (!forced && postsSince(posted, 'B') >= (t.B?.every ?? 3) - 1))) {
    return { type: 'B', experience: fresh[0] };
  }
  return { type: 'A' };
}

// セールの情報（名前と期間）。お買い物マラソンなどの期間 → 5と0のつく日 → 商品のタイムセール の順に使う
export function saleInfo({ sale, boost, item, now = new Date() }) {
  if (sale) {
    const start = parseJst(sale.start);
    const end = parseJst(sale.end);
    return { name: sale.name, start, end, line: `🗓 ${sale.name}：${formatJst(start)}〜${formatJst(end)}` };
  }
  if (boost) {
    // 今日が対象日でなければ（前日扱い）、明日が対象日
    const today = jst(now);
    const day = boost.days?.includes(today.getUTCDate()) ? today : jst(now.getTime() + DAY);
    const label = `${day.getUTCMonth() + 1}/${day.getUTCDate()}`;
    const start = new Date(`${day.toISOString().slice(0, 10)}T00:00:00+09:00`);
    const end = new Date(start.getTime() + DAY - 60000);
    return { name: '5と0のつく日', start, end, line: `🗓 楽天 5と0のつく日：${label} 0:00〜23:59` };
  }
  const end = parseJst(item?.saleEnd);
  if (end && end > now) {
    const start = parseJst(item.saleStart);
    return {
      name: 'ショップのセール',
      start,
      end,
      line: `🗓 ショップのセール：${start ? `${formatJst(start)}〜` : ''}${formatJst(end)}まで`,
    };
  }
  return null;
}

// B型の末尾に付ける「いまの価格・セール状況」（データから機械的に作る）
export function priceLine(item, now = new Date()) {
  const extras = [];
  if (item.postageIncluded) extras.push('送料無料');
  if (item.pointRate >= 2) extras.push(`ポイント${item.pointRate}倍`);
  return `💰 いまの価格：${yen(item.price)}円${extras.length ? `（${extras.join('・')}）` : ''}　※${formatJst(now)}時点`;
}

// ---- C：まとめ型 ----

// 月初のセールカレンダー。楽天の期間（config.json の campaign.periods、自動取得）と、
// data/sale_calendar.json に人が書いた予定（Amazon など）をまとめる。日程は推測で書かない。
export function calendarPost({ periods = [], extra = [], boostDays, now = new Date(), closing }) {
  const month = jstMonth(now);
  const monthNo = jst(now).getUTCMonth() + 1;
  const events = [...periods.map((p) => ({ store: '楽天', ...p })), ...extra]
    .map((e) => ({ ...e, s: parseJst(e.start), e: parseJst(e.end) }))
    .filter((e) => e.s && e.e && (jstMonth(e.s) === month || jstMonth(e.e) === month))
    .sort((a, b) => a.s - b.s);
  const lines = [`📅 ${monthNo}月のセールカレンダー`, ''];
  for (const e of events) {
    lines.push(`・${e.store ? `${e.store} ` : ''}${e.name}　${formatJst(e.s)}〜${formatJst(e.e)}`);
    if (e.summary) lines.push(`　${e.summary}`);
  }
  if (boostDays?.days?.length) lines.push(`・楽天 5と0のつく日　${boostDays.days.join('・')}日`);
  if (events.length === 0) lines.push('（ほかの大きなセールは、日程が発表されたらお知らせします）');
  lines.push('', '日程は各ストアの発表をもとにしています。変更になることがあります。');
  if (closing) lines.push(closing);
  return { text: lines.join('\n'), eventCount: events.length };
}

// 月末のまとめ。今月紹介した商品を、いまのレビュー評価で並べる。
// 「買ってよかった」は、全部に体験メモがあるときだけ使う（体験していないものを「よかった」と書かない）。
export function rankForTop(items, count = 5) {
  return [...items]
    .filter((it) => it && it.availability === 1 && it.reviewCount > 0)
    .sort((a, b) => b.reviewAverage + Math.log10(b.reviewCount) / 10 - (a.reviewAverage + Math.log10(a.reviewCount) / 10))
    .slice(0, count);
}

export function topPost(items, { now = new Date(), experiences = [], closing } = {}) {
  const monthNo = jst(now).getUTCMonth() + 1;
  const tried = items.length > 0 && items.every((it) => experiences.some((e) => e.itemCode === it.itemCode));
  const title = tried
    ? `🏆 ${monthNo}月に買ってよかったものTop${items.length}`
    : `🏆 ${monthNo}月に紹介した中で、レビュー評価が高かったTop${items.length}`;
  const lines = [title, ''];
  items.forEach((it, i) => {
    lines.push(`${i + 1}位 ${cleanName(it.name, 26)}`);
    lines.push(`　${yen(it.price)}円・★${it.reviewAverage.toFixed(2)}（${yen(it.reviewCount)}件）`);
  });
  lines.push('', `価格は${formatJst(now)}時点。リンクはリプライに付けます👇`);
  if (closing) lines.push(closing);
  return { text: lines.join('\n'), tried };
}

// ---- D：質問型 ----
export function questionPost(photo, { questions = [], random = Math.random } = {}) {
  const ask = questions.length ? questions[Math.floor(random() * questions.length)] : 'あと何かいるかな？おすすめあれば教えてください🙏';
  return [photo.memo?.trim(), ask].filter(Boolean).join('\n');
}

// ---- 効果測定のための記録 ----
const hasNumber = (s) => /\d/.test(s);
export function logFields({ type, kind, text, sale, mediaCount }) {
  const head = String(text).split('\n').filter((l) => l.trim()).slice(0, 2).join('\n');
  return {
    template_type: type,
    ...(kind ? { template_kind: kind } : {}),
    has_price: /[\d,]+\s*円/.test(text),
    has_discount_rate: /\d+\s*[%％]|\d+\s*倍/.test(text),
    number_in_head: hasNumber(head),
    sale_name: sale?.name || null,
    has_media: mediaCount > 0,
  };
}
