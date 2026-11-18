// 投稿文（親投稿の本文＋リプライの一言）を Claude に書いてもらう。
// 失敗したとき・ルール違反の文が返ってきたときは null を返し、呼び出し側が定型文に切り替える。
//
// アカウントごとに変わる部分（キャラ・口調・テーマ・共感の例など）は config.json の persona に書く。
// ここにあるのは、どのアカウントでも守る共通ルール（景品表示法・ステマ規制・薬機法などへの対応）と、
// Threads で読まれやすい形（親投稿は3行まで・1行目がつかみ・リプライにリンク先が気になる一言）。

import Anthropic from '@anthropic-ai/sdk';
import { cleanName } from './compose.js';
import { parseJst } from './select.js';
import { formatJst } from './templates.js';

const MODEL = 'claude-sonnet-5-5';
const CAPTION_MAX = 800;
const SEPARATOR = '---';

const bullets = (list) => (list || []).map((s) => `- ${s}`).join('\n');

// type：'A'（セール速報型・商品紹介）か 'B'（実体験レビュー型。人が書いた体験メモがあるときだけ）
export function buildSystemPrompt(persona, type = 'A') {
  const review = type === 'B';
  const body = review
    ? `# 親投稿の本文（実体験レビュー）
- 商品データの「体験メモ」は、アカウントの運営者が実際に使って書いたもの。**体験メモに書いてあることだけ**をもとに、運営者の体験として書く。メモにない体験・感想・期間は作らない。
- **5行以内**（1行は30文字くらいまで）。
- **1〜2行目に具体的な数字**を入れる（体験メモの使った期間、または価格）。
- 使った期間、良かった点、**微妙だった点を必ず1つ**入れる。
- 価格・セール状況はシステムが末尾に付けるので、本文の最後で価格を繰り返さなくてよい。
- 絵文字は0〜2個まで。`
    : `# 親投稿の本文（セール速報）
- **3行以内**（1行は30文字くらいまで）。1投稿で伝えるテーマは1つだけ。
- **1行目**：スクロールの手を止めるつかみ。商品データの「つかみの型」に合わせる（2026-11-09 Muse の提案 P02・P03）。
  - 問いかけ型：読む人に聞く形にして「？」で終える（例：「加湿器、もう出したにゃ？」「朝の支度でバタバタしてる人いるにゃ？」）。
  - 場面型：今の季節の体感（ひんやり・乾燥など）や、具体的な場面（夜・朝の支度・帰り道など）から入る（例：「11月、足元からひんやりしてきた夜…」）。
  - 商品データに「セール名」があれば、1行目に必ず入れる（例：「お買い物マラソン中だけど、加湿器もう出したにゃ？」）。
  - 価格やポイント倍率だけの1行目にはしない（数字は2行目に入れればよい）。商品データの「最近使ったつかみ」と同じ・似た出だしは使わない。
- **2行目**：何の商品かと、価格（「〇〇円」の形）。ポイント倍率があれば添えてよい。
- 3行目：${persona.audience || '生活者'}の困りごとへの共感と、商品で何が楽になるか。「安い」「お得」のような抽象的な言葉だけで終わらせない。
- セールの期間はシステムが別の行で付けるので、本文に書かなくてよい。商品データの「セール期間」が「今日」より後に始まる（明日から）ときは、明日のセールの予告として書く（例：「明日は5と0のつく日にゃ」）。今日がセール当日のように書かない。
- セール期間中でも、この商品がセールで値下げされたとは書かない（値下げ前の価格・割引率はデータにない）。
- 数字や事実は商品データにあるもの（価格、送料無料、ポイント倍率、レビュー評価${persona.use_spec ? '、商品説明にあるスペック' : ''}）だけを使う。
- 絵文字は0〜2個まで。`;
  return `あなたは Threads の「${persona.account_name}」アカウントの投稿文を書きます。
${persona.topic}を紹介する投稿を、「親投稿の本文」と「リプライの一言」の2つに分けて書いてください。
親投稿にはシステムが商品画像を付け、リプライにはシステムが商品リンクを付けます。

${body}

# リプライの一言
- リンク先が気になる短い一言。1行・25文字くらいまで（例：「2個入りでこの価格はうれしい😋」「サイズ感はこちらで見られるよ」）。

# 口調
${bullets(persona.voice)}

# 入れる要素
${bullets(persona.include)}

# 禁止
- 「【セール情報】」「◯◯%OFF！」「お得です！」のようなお知らせ調の定型文。
- 「急げ」「お急ぎください」「お見逃しなく」「今すぐ」などの煽り。
- 根拠のない強い言葉のつかみ：「【速報】」「知らないと損」「騙されないで」「本当は教えたくない」「ここだけの話」「断言します」「炎上覚悟」「批判覚悟」など。
- ハッシュタグ（#）、URL、「PR」の表記（これらはシステムが別に付ける）。
${review ? '- 体験メモにない体験談・感想（メモにない期間・回数・「リピ買い」など）。' : '- 自分が使った・買った・リピートしているかのような体験談（「使ってみたら」「リピ買い」「愛用」など）。あなたは商品を使っていない。'}
- 商品データにない事実を作ること。他店や他の商品との価格比較、「最安」「最強」「No.1」、データで確認できない値引き・割引率・定期便・まとめ買い割引は書かない。
- 効果・効能や健康への良さをうたう表現（体にいい、健康的、痩せる、治る、美白、育毛など）。
- 商品データの「今日」の季節に合わない話題（10月に「夏の暑さ」、6月に「冬の寒さ」など）。季節ものの商品は、これからの季節や季節の変わり目の話にする。
- 商品データにない数字。数字は商品データ（商品名・価格・レビュー・セール終了日時${persona.use_spec ? '・商品説明' : ''}${review ? '・体験メモ' : ''}）に書いてあるものだけを使う。
${bullets(persona.avoid)}

# 出力
親投稿の本文、「${SEPARATOR}」だけの行、リプライの一言、の順に出力する。前置き・説明・かぎかっこは付けない。`;
}

export function facts(item, { groupLabel, genreName, now, persona, recentHooks = [], sale = null, experience = null, hookStyle = null }) {
  const end = parseJst(item.saleEnd);
  const f = {
    // 季節に合った共感を書けるように、投稿する日（日本時間）を渡す
    今日: now ? now.toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'long', day: 'numeric' }) : 'なし',
    商品名: cleanName(item.name, 80),
    ジャンル: `${groupLabel}（${genreName}）`,
    価格: `${item.price.toLocaleString('ja-JP')}円`,
    送料: item.postageIncluded ? '送料無料' : '送料別',
    ポイント倍率: item.pointRate >= 2 ? `${item.pointRate}倍` : 'なし',
    セール終了: end && end > now ? item.saleEnd : 'なし',
    レビュー: item.reviewCount > 0 ? `平均${item.reviewAverage.toFixed(2)}（${item.reviewCount}件）` : 'なし',
  };
  f.セール名 = sale?.name || 'なし';
  if (sale?.start && sale?.end) f.セール期間 = `${formatJst(sale.start)}〜${formatJst(sale.end)}`;
  if (experience) {
    f.体験メモ = {
      使った期間: experience.used_for || 'なし',
      良かった点: experience.good || [],
      微妙だった点: experience.bad || 'なし',
      ...(experience.note ? { ひとこと: experience.note } : {}),
    };
  }
  if (recentHooks.length) f.最近使ったつかみ = recentHooks;
  if (hookStyle) f.つかみの型 = `${hookStyle}型`;
  if (persona?.use_spec && item.caption) {
    f.商品説明 = item.caption.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, CAPTION_MAX);
  }
  return f;
}

// 体験談の言葉（B型＝人が書いた体験メモがあるときだけ使ってよい）
const EXPERIENCE = /使ってみ|使ってる|買ってみ|リピ|愛用|買ってよかった/;
const BANNED = [
  /https?:\/\//, /#/, /PR/i, /【/,
  /急げ|急いで|お急ぎ|お見逃し|今すぐ/,
  /速報|知らないと.{0,6}損|騙され|だまされ|教えたくない|ここだけの話|断言|炎上覚悟|批判覚悟/,
  /ドラッグストアより|スーパーより|店より安|最安|最強|No\.?\s?1|ナンバーワン|一番安/i,
  /定期便|まとめ買いで.{0,4}割/,
  /\d+\s*[%％]\s*(OFF|オフ)/i,
  /体にいい|体に良い|健康的|栄養満点|痩せ|やせる|治る|美白|育毛/,
];

// 「2,980」「4.62」「08」などを比較しやすい形（カンマなし・先頭の0なし）にそろえる
const numbers = (s) =>
  [...String(s).replace(/(\d),(\d)/g, '$1$2').matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0].replace(/^0+(?=\d)/, ''));

const lines = (s) => s.split('\n').filter((l) => l.trim() !== '');

// つかみ（1行目）の出だしを比べるために、記号・空白・絵文字を除いた最初の数文字にそろえる
const HOOK_HEAD = 4;
export const hookHead = (line) =>
  String(line || '')
    .replace(/[\s、。，．,.!！?？…・「」『』()（）\p{Extended_Pictographic}]/gu, '')
    .slice(0, HOOK_HEAD);
export const firstLine = (text) => lines(text)[0] || '';

// つかみの型（A型）。直近のつかみのうち問いかけ型（「？」を含む）が半分より少なければ問いかけ型、そうでなければ場面型
export function hookStyleFor(recentHooks = []) {
  const questions = recentHooks.filter((h) => /[?？]/.test(h)).length;
  return questions * 2 < recentHooks.length || recentHooks.length === 0 ? '問いかけ' : '場面';
}

// AIの文を親投稿とリプライに分ける。形が崩れていれば null
export function splitPost(text) {
  const parts = text.split(new RegExp(`^\\s*${SEPARATOR}+\\s*$`, 'm'));
  if (parts.length !== 2) return null;
  return { parent: parts[0].trim(), reply: parts[1].trim() };
}

// セール名のうち、1行目に入っているか確かめる部分（「お買い物マラソン 10月第3弾」→「お買い物マラソン」）
export const saleKeyword = (name) => (name === '5と0のつく日' ? '5と0' : String(name || '').split(/[\s（(]/)[0]);

// 1行目の出だしを比べる前に、セール名とそれに続く「中・に・で・、」などを取り除く。
// セール名は毎回同じなので、残すとどの投稿も「同じ出だし」になってしまう（2026-11-02 Muse の指摘で修正）
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const SALE_NAMES = ['5と0のつく日', 'お買い物マラソン', '楽天スーパーセール', 'スーパーセール', 'ショップのセール'];
export function stripSale(line, saleName = null) {
  const names = [saleName, saleName && saleKeyword(saleName), ...SALE_NAMES].filter(Boolean).map(escapeRe);
  const re = new RegExp(`(${names.join('|')})(\\s*\\d+月第\\d+弾)?(の期間)?(中|に|で|は|の|から|だから|って)?[、,・\\s]*`, 'g');
  return String(line || '').replace(re, '');
}

// AIの文がルールを守っているか確かめる。問題があれば理由を返す。
// factsText：AIに渡した商品データ。本文の数字はすべてこの中にある数字でなければならない。
// type：'A'（3行まで・体験談禁止）か 'B'（5行まで・体験メモがあるので体験談の言葉はよい）
export function checkPost(
  post,
  item,
  { factsText = '', extraBanned = [], mustInclude = null, recentHooks = [], type = 'A', saleName = null, hookStyle = null } = {},
) {
  if (!post) return `「${SEPARATOR}」で親投稿とリプライに分かれていない`;
  const { parent, reply } = post;
  const maxLines = type === 'B' ? 5 : 3;
  const maxLen = type === 'B' ? 200 : 120;
  if (lines(parent).length > maxLines) return `親投稿が${lines(parent).length}行ある（${maxLines}行まで）`;
  if (parent.length < 20 || parent.length > maxLen) return `親投稿の文字数が範囲外（${parent.length}文字。20〜${maxLen}文字）`;
  if (lines(reply).length !== 1 || reply.length > 40) return `リプライの一言が長い（1行・40文字まで）`;
  // 冒頭1〜2行に具体的な数字（価格・ポイント倍率・期間など）を入れる
  if (!/\d/.test(lines(parent).slice(0, 2).join(''))) return '冒頭の2行に数字（価格・ポイント倍率など）がない';
  // A型：セール中なら1行目にセール名
  if (type === 'A' && saleName && !firstLine(parent).includes(saleKeyword(saleName))) return `1行目にセール名（${saleKeyword(saleName)}）がない`;
  // 問いかけ型のつかみは「？」で終える（効果を比べられるように、型どおりに書かせる）
  if (type === 'A' && hookStyle === '問いかけ' && !/[?？]/.test(firstLine(parent))) return '問いかけ型なのに1行目に「？」がない';
  // 「安い」「お得」のような抽象的な言葉だけで終わらせない
  const last = lines(parent).at(-1) || '';
  if (/安い|お得/.test(last) && !/\d/.test(last)) return '最後の行が「安い」「お得」などの抽象的な言葉で終わっている';
  // 直近の投稿と同じ出だしのつかみは使わない（セール名は毎回同じなので除いて比べる）
  const head = hookHead(stripSale(firstLine(parent), saleName));
  if (head && recentHooks.some((h) => hookHead(stripSale(h, saleName)) === head)) return `つかみ「${firstLine(parent)}」が最近の投稿と同じ出だし`;
  const all = `${parent}\n${reply}`;
  const banned = [...BANNED, ...(type === 'B' ? [] : [EXPERIENCE]), ...extraBanned.map((p) => new RegExp(p, 'i'))];
  const hit = banned.find((re) => re.test(all));
  if (hit) return `禁止表現を含む（${hit}）`;
  const allowed = new Set(numbers(`${factsText} ${item.price} ${item.name}`));
  const unknown = numbers(all).find((n) => !allowed.has(n));
  if (unknown) return `データにない数字（${unknown}）`;
  // キャラの口癖など、必ず入れたい言葉（persona.must_include。親投稿とリプライの合計で数える）
  if (mustInclude) {
    const count = all.split(mustInclude.pattern).length - 1;
    if (count < mustInclude.min) return `「${mustInclude.pattern}」が${count}回しかない（${mustInclude.min}回以上必要）`;
  }
  return null;
}

export async function writePost(item, ctx, { client = new Anthropic() } = {}) {
  const persona = ctx.persona;
  const hookStyle = (ctx.type || 'A') === 'A' ? hookStyleFor(ctx.recentHooks) : null;
  const input = JSON.stringify(facts(item, { ...ctx, hookStyle }), null, 2);
  const messages = [{ role: 'user', content: `次の商品の投稿文を書いてください。\n\n${input}` }];
  // ルール違反のときは、理由を伝えて2回まで書き直してもらう
  for (let attempt = 1; attempt <= 3; attempt++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      // 安全判定で断られた場合は、サーバー側で別モデルに切り替えて続ける
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system: buildSystemPrompt(persona, ctx.type),
      messages,
    });
    if (response.stop_reason === 'refusal') {
      console.log('AIが投稿文の作成を断ったため、定型文を使います。');
      return null;
    }
    const text = response.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    const post = splitPost(text);
    const problem = checkPost(post, item, {
      factsText: input,
      extraBanned: persona.extra_banned,
      mustInclude: persona.must_include,
      recentHooks: ctx.recentHooks,
      type: ctx.type,
      saleName: ctx.sale?.name,
      hookStyle,
    });
    if (!problem) return { ...post, hookStyle };
    console.log(`AIの文を使いません（${attempt}回目）：${problem}\n${text}`);
    messages.push(
      { role: 'assistant', content: response.content },
      { role: 'user', content: `この投稿文はルール違反です（${problem}）。ルールを守って、同じ形で書き直してください。` },
    );
  }
  return null;
}
