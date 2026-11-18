// 投稿文を組み立てる。Threads の上限は500文字。
//
// 1回の紹介は「親投稿」と「リプライ」の2つに分ける。
//   親投稿：商品画像＋生活の共感を書いた本文（外部リンクなし）＋PR表記
//   リプライ：アフィリエイトリンク（リンクカード）＋PR表記
// 本文は通常 AI が書き（writer.js）、使えないときはここの定型文を使う。

import { parseJst } from './select.js';

const MAX_LEN = 500;

// 楽天の商品名は【送料無料】などの宣伝文句が長く付いているので削る
export function cleanName(name, max = 48) {
  let s = String(name)
    .replace(/【[^】]*】|\[[^\]]*\]|［[^］]*］|＼[^／]*／|<[^>]*>|≪[^≫]*≫|《[^》]*》|（[^）]*(送料|クーポン|OFF|ポイント)[^）]*）/gi, ' ')
    // 日付・ポイント・クーポンなどの宣伝文句（「10/30限定P2倍」「早割 クーポン」など）
    .replace(/\d{1,2}\/\d{1,2}\s*(限定|まで|迄)?|[PＰ]\d+倍|ポイント\d+倍|クーポン(利用)?で?|送料無料|早割|期間限定|数量限定/g, ' ')
    .replace(/[★☆◆◇■□●○※!！]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length > max) {
    // 単語の途中で切れないよう、上限より手前の区切り（空白）で切る
    const cut = s.slice(0, max);
    const space = cut.lastIndexOf(' ');
    s = (space > max * 0.6 ? cut.slice(0, space) : cut).trim() + '…';
  }
  return s;
}

const yen = (n) => n.toLocaleString('ja-JP');

export function formatEnd(end) {
  const jst = new Date(end.getTime() + 9 * 60 * 60 * 1000);
  const mm = String(jst.getUTCMinutes()).padStart(2, '0');
  return `${jst.getUTCMonth() + 1}/${jst.getUTCDate()} ${jst.getUTCHours()}:${mm}`;
}

const pickFrom = (list, random) => list[Math.floor(random() * list.length)];

// 定型文（AIが使えないとき用）。共感の一言とリプライの一言は config.json の persona.template に書く。
// A型（セール速報）：1行目 セール名＋数字 → 2行目 商品名＋価格 → 3行目 共感
export function templatePost(item, { groupLabel, template, now = new Date(), random = Math.random, sale = null } = {}) {
  const end = parseJst(item.saleEnd);
  const empathy = pickFrom(template.empathy[groupLabel] || template.empathy_default, random);
  const number = item.pointRate >= 2 ? `ポイント${item.pointRate}倍` : `${yen(item.price)}円`;
  // 1行目：セール名＋数字を、カタログのような並べ方ではなく一言の形にする（persona.template.sale_hooks。{sale}・{number} を置きかえる）
  const hooks = template.sale_hooks?.length ? template.sale_hooks : ['{sale}中、{number}のを見つけた'];
  const saleLabel = sale ? sale.name : end && end > now ? `${formatEnd(end)}までのセール` : null;
  const plain = template.number_hooks?.length ? template.number_hooks : ['{number}のを見つけた'];
  const head = (saleLabel ? pickFrom(hooks, random) : pickFrom(plain, random)).replaceAll('{sale}', saleLabel).replaceAll('{number}', number);
  return {
    parent: [head, `${cleanName(item.name, 30)}：${yen(item.price)}円${item.postageIncluded ? '（送料無料）' : ''}`, empathy].join('\n'),
    reply: pickFrom(template.closing, random),
  };
}

// B型（実体験レビュー）の定型文。人が書いた体験メモをそのまま並べる（AIが使えないとき用）
export function reviewTemplatePost(experience, { template, random = Math.random } = {}) {
  const good = [].concat(experience.good || []);
  const lines = [`${experience.used_for ? `${experience.used_for}使ってみて` : '使ってみて'}の正直な感想`];
  if (good.length) lines.push(`良かった：${good.slice(0, 2).join('／')}`);
  if (experience.bad) lines.push(`微妙だった：${experience.bad}`);
  if (experience.note) lines.push(experience.note);
  return { parent: lines.join('\n'), reply: pickFrom(template.closing, random) };
}

// 親投稿にはリンクを書かないが、商品紹介（広告）なので PR 表記は親にも必ず入れる。
// トピックタグ（#）は基本付けない（posting.use_topic_tag が true のときだけ）
// extra：本文の下に付ける決まった行（セールの期間、B型の「いまの価格」など）
export function buildParent(body, { tag, notice, extra = [] } = {}) {
  const lines = [body.trim(), ''];
  for (const l of extra) if (l) lines.push(l);
  if (notice) lines.push(notice);
  lines.push('PR');
  if (tag) lines.push(`#${tag}`);
  const text = lines.join('\n');
  if (text.length > MAX_LEN) throw new Error(`親投稿が${MAX_LEN}文字を超えています（${text.length}文字）`);
  return text;
}

// リプライ：リンク先が気になる一言 ＋ PR表記（リンクはカードで付く）
export function buildReply({ hook, notice } = {}) {
  const lines = [];
  if (hook) lines.push(hook.trim());
  lines.push('【PR】商品ページはこちら👇');
  if (notice) lines.push(notice);
  return lines.join('\n');
}
