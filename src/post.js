// 1回の実行で1商品を Threads に紹介する（アカウントのキャラ・テーマは config.json の persona）。
//   親投稿（商品画像＋共感の本文＋PR表記）→ 少し待つ → リプライ（アフィリエイトリンク＋PR表記）
//
// 環境変数
//   RAKUTEN_APP_ID / RAKUTEN_ACCESS_KEY / RAKUTEN_AFFILIATE_ID … 楽天の認証情報
//   THREADS_ACCESS_TOKEN … Threads の長期アクセストークン
//   ANTHROPIC_API_KEY … 親投稿の本文を AI で書くためのキー（ないときは定型文）
//   DRY_RUN=1 … 投稿せず、投稿文を表示するだけ
//   SLOT=campaign … セール期間・5と0のつく日用の追加枠。それ以外の日は何もしない
//   SLOT=prime … 20時台の枠。一番点数の高い商品（推し商品）を選ぶ
//   TRIGGER=timer … 外部のタイマー（cron-job.org）から起動されたとき。今の時刻（日本時間）から枠を自分で判断する
//   GROUP=お酒 … 試し用。指定したグループから選ぶ
//   ACCOUNT=neko … どのアカウントで動かすか（accounts/ の中のフォルダ名。必須）
//   PRESET=desk … 試し用（DRY_RUN のときだけ）。presets/desk.json の設定で投稿文を作ってみる
//   TEMPLATE=B / C-calendar / C-top / D … 試し用。投稿の型を指定する（ふだんは templates.js が自動で選ぶ）

import { readFile, writeFile } from 'node:fs/promises';
import { searchSaleItems, ranking, itemByCode } from './rakuten.js';
import { pick, genreFor, inSeason, parseJst } from './select.js';
import { templatePost, reviewTemplatePost, buildParent, buildReply, cleanName } from './compose.js';
import { writePost, firstLine } from './writer.js';
import { publishParent, publishReply, NoImageError } from './threads.js';
import {
  chooseTemplate,
  saleInfo,
  priceLine,
  calendarPost,
  itemsThisMonth,
  rankForTop,
  topPost,
  questionPost,
  logFields,
} from './templates.js';

import { ROOT, accountDir } from './account.js';

// アカウントごとのフォルダ（accounts/<ACCOUNT>/）。ACCOUNT がないときは main() で分かりやすいエラーにする
const ACC = () => accountDir();
const POSTED_PATH = () => new URL('data/posted.json', ACC());
const KEEP_RECORDS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomBetween = (min, max) => min + Math.random() * (max - min);

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`環境変数 ${name} が設定されていません（GitHub の Secrets を確認してください）`);
  return v;
}

export function inCampaign(periods, now = new Date()) {
  return periods.find((p) => {
    const start = parseJst(p.start);
    const end = parseJst(p.end);
    return start && end && start <= now && now <= end;
  });
}

// 5と0のつく日（楽天でポイントが上がりやすい日）とその前日は、セール期間と同じ扱いにする
export function isBoostDay(boost, now = new Date()) {
  if (!boost?.days?.length) return false;
  const jst = (d) => new Date(d.getTime() + 9 * 3600 * 1000).getUTCDate();
  if (boost.days.includes(jst(now))) return true;
  return Boolean(boost.include_day_before && boost.days.includes(jst(new Date(now.getTime() + 24 * 3600 * 1000))));
}

// 5と0のつく日の前日（当日ではない）なら true。前夜の予告の枠を残すために使う
export function isBoostEve(boost, now = new Date()) {
  if (!boost?.days?.length) return false;
  const day = (d) => new Date(d.getTime() + 9 * 3600 * 1000).getUTCDate();
  return !boost.days.includes(day(now)) && boost.days.includes(day(new Date(now.getTime() + 24 * 3600 * 1000)));
}

// 前夜の予告の枠（posting.boost_eve = { daily_limit: 5, reserve_hour: 22 }）。
// 前日は上限を daily_limit にし、最後の1本は reserve_hour（22時台）の予告のために残す。残すべきときは理由を返す
export function eveLimit(eve, today, hour) {
  if (!eve) return { limit: null, skip: null };
  if (hour !== eve.reserve_hour && today >= eve.daily_limit - 1) {
    return { limit: eve.daily_limit, skip: `明日は5と0のつく日なので、最後の1本は${eve.reserve_hour}時台の予告のために残します。` };
  }
  return { limit: eve.daily_limit, skip: null };
}

const jstDate = (d) => new Date(new Date(d).getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);

export function postsToday(posted, now = new Date()) {
  return posted.filter((p) => jstDate(p.postedAt) === jstDate(now)).length;
}

// 人が書くデータ（体験メモ・デスク写真・セールの予定）。ファイルがなければ空
async function readData(name) {
  try {
    return JSON.parse(await readFile(new URL(`data/${name}`, ACC()), 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw new Error(`data/${name} が読めません（JSON の書き方を確認してください）：${e.message}`);
  }
}

async function savePosted(posted) {
  await writeFile(POSTED_PATH(), JSON.stringify(posted.slice(-KEEP_RECORDS), null, 2) + '\n');
}

// 前回リプライ（リンク）の投稿に失敗した親投稿があれば、先にリプライを付け直す
async function retryPendingReplies(posted, { userId, token }) {
  for (const p of posted.filter((r) => r.replyPending)) {
    console.log(`リンクのリプライが付いていない投稿があるので付け直します：${p.permalink}`);
    try {
      const reply = await publishReply({ userId, parentId: p.threadsId, text: p.replyText, link: p.url, token });
      Object.assign(p, { replyId: reply.id, replyPending: false });
      await savePosted(posted);
    } catch (e) {
      console.log(`付け直しに失敗しました（次回またやり直します）：${e.message}`);
    }
  }
}

const jstParts = (d) => {
  const j = new Date(d.getTime() + 9 * 3600 * 1000);
  return { date: j.toISOString().slice(0, 10), hour: j.getUTCHours(), dow: j.getUTCDay() };
};

// 外部タイマーから起動されたとき、今の時刻（日本時間）がどの投稿枠かを返す。投稿時間でなければ null
//   posting.slots = { weekday: [7,12,18,20,22], weekend: [9,15,18,20,22], campaign_extra: [10,21], prime_hour: 20 }
export function slotForNow(slots, now = new Date()) {
  const { hour, dow } = jstParts(now);
  const list = dow === 0 || dow === 6 ? slots.weekend : slots.weekday;
  if (list.includes(hour)) return hour === slots.prime_hour ? 'prime' : 'regular';
  if ((slots.campaign_extra || []).includes(hour)) return 'campaign';
  return null;
}

// 同じ時間帯（日本時間の同じ日・同じ時）にもう投稿していれば true（タイマーの二重起動などで2回投稿しないため）
export function postedThisHour(posted, now = new Date()) {
  const cur = jstParts(now);
  return posted.some((p) => {
    const t = jstParts(new Date(p.postedAt));
    return t.date === cur.date && t.hour === cur.hour;
  });
}

// 定期実行（cron・UTC）が本来動くはずだった直近の時刻から、何分遅れているかを返す。
// GitHub の定期実行は混雑すると数時間遅れることがあるので、遅れすぎた実行は投稿しない。
export function scheduleDelayMinutes(cron, now = new Date()) {
  const m = String(cron || '').trim().match(/^(\d+)\s+(\d+)\s/);
  if (!m) return null;
  const due = new Date(now);
  due.setUTCHours(Number(m[2]), Number(m[1]), 0, 0);
  if (due > now) due.setUTCDate(due.getUTCDate() - 1);
  return Math.round((now - due) / 60000);
}

async function main() {
  const dryRun = process.env.DRY_RUN === '1';
  const preset = process.env.PRESET;
  if (preset && !dryRun) throw new Error('PRESET は投稿しないテスト（DRY_RUN）のときだけ使えます');
  const configUrl = preset ? new URL(`presets/${preset.replace(/[^a-z0-9_-]/gi, '')}.json`, ROOT) : new URL('config.json', ACC());
  const config = JSON.parse(await readFile(configUrl, 'utf8'));
  const posted = preset ? [] : JSON.parse(await readFile(POSTED_PATH(), 'utf8'));
  console.log(`アカウント：${process.env.ACCOUNT}（@${config.account.threads_username}）`);
  const timer = process.env.TRIGGER === 'timer';
  const scheduled = process.env.GITHUB_EVENT_NAME === 'schedule' || timer;
  const posting = config.posting;
  let slot = process.env.SLOT || 'regular';

  if (config.paused && scheduled) {
    console.log('config.json の paused が true なので、定期実行の投稿はお休みします。');
    return;
  }

  // 予定時刻から大きく遅れた定期実行は、深夜などに投稿してしまわないよう何もしない
  const maxDelay = posting.max_delay_minutes ?? 90;
  const delay = scheduled ? scheduleDelayMinutes(process.env.SCHEDULE) : null;
  if (delay !== null && delay > maxDelay) {
    console.log(`定期実行が予定より${delay}分遅れて始まったので、今回は投稿しません（上限${maxDelay}分）。`);
    return;
  }

  // 外部タイマーから起動されたときは、今の時刻から投稿枠を決める
  if (timer) {
    slot = slotForNow(posting.slots);
    if (!slot) {
      console.log('今は投稿する時間帯ではないので、何もしません。');
      return;
    }
    if (postedThisHour(posted)) {
      console.log('この時間帯はもう投稿済みなので、何もしません。');
      return;
    }
    console.log(`外部タイマーから起動されました（枠：${slot}）。`);
  }

  const sale = inCampaign(config.campaign.periods);
  const boost = isBoostDay(config.campaign.boost_days);
  const campaign = sale || boost;
  if (slot === 'campaign' && !campaign) {
    console.log('セール期間でも5と0のつく日でもないので、追加枠の投稿はしません。');
    return;
  }
  if (campaign) console.log(sale ? `セール期間中（${sale.name}）です。` : '5と0のつく日（またはその前日）です。');

  // 1日の投稿数の上限（手動の試し投稿も数に入れる）
  let limit = campaign ? posting.campaign_daily_limit : posting.daily_limit;
  const today = postsToday(posted);
  // 5と0のつく日の前日は、22時台の予告の枠を残す（posting.boost_eve があるアカウントだけ）
  const eve = posting.boost_eve && !sale && isBoostEve(config.campaign.boost_days) ? posting.boost_eve : null;
  const eveRule = eveLimit(eve, today, jstParts(new Date()).hour);
  if (eveRule.limit) limit = eveRule.limit;
  if (!dryRun && eveRule.skip) {
    console.log(eveRule.skip);
    return;
  }
  if (!dryRun && today >= limit) {
    console.log(`今日はすでに${today}回投稿したので、上限（${limit}回）に達しています。`);
    return;
  }

  // 毎回同じ時刻にならないよう、定期実行では数分ずらしてから投稿する
  if (scheduled && posting.jitter_minutes > 0) {
    const wait = randomBetween(0, posting.jitter_minutes * 60 * 1000);
    console.log(`投稿時刻をずらすため、${Math.round(wait / 1000)}秒待ちます。`);
    await sleep(wait);
  }
  const now = new Date();

  const token = dryRun ? null : requireEnv('THREADS_ACCESS_TOKEN');
  const userId = config.account.threads_user_id;
  if (!dryRun) await retryPendingReplies(posted, { userId, token });

  const ctx = {
    origin: config.rakuten.origin,
    credentials: {
      applicationId: requireEnv('RAKUTEN_APP_ID'),
      accessKey: requireEnv('RAKUTEN_ACCESS_KEY'),
      affiliateId: requireEnv('RAKUTEN_AFFILIATE_ID'),
    },
  };
  // 体験メモは、このアカウントの担当ジャンル（genres の label）のものだけ使う
  const labels = config.genres.map((g) => g.label);
  const experiences = (await readData('experiences.json')).filter((e) => {
    if (labels.includes(e.group)) return true;
    console.log(`体験メモ ${e.itemCode} の group「${e.group}」は担当ジャンル（${labels.join('・')}）にないので使いません。`);
    return false;
  });
  const photos = await readData('desk_photos.json');
  const choice = chooseTemplate({
    posted,
    templates: config.templates,
    now,
    experiences,
    photos,
    repostAfterDays: posting.repost_after_days,
  });
  console.log(`今回の投稿の型：${choice.type}${choice.kind ? `（${choice.kind}）` : ''}`);
  const env = { config, posted, now, dryRun, userId, token, ctx, sale, boost, slot, experiences };

  if (choice.type === 'C' && choice.kind === 'calendar') return postCalendar(env);
  if (choice.type === 'C' && choice.kind === 'top' && (await postTop(env))) return;
  if (choice.type === 'D') return postQuestion(env, choice.photo);
  let item = null;
  if (choice.type === 'B') {
    item = await itemByCode(choice.experience.itemCode, config.rakuten, ctx);
    if (!item || item.availability !== 1) {
      console.log(`体験メモの商品（${choice.experience.itemCode}）が見つからない・売り切れのため、A型にします。`);
      item = null;
    }
  }
  const type = item ? 'B' : 'A';
  return postItem(env, { type, item, experience: item ? choice.experience : null });
}

// 担当グループ・ジャンルからセール品を1つ探す
async function findItem({ config, posted, now, ctx, slot }) {
  // 20時台の枠では、上位からランダムではなく一番点数の高い商品（推し商品）を選ぶ
  const prime = slot === 'prime';
  if (prime) console.log('20時台の枠なので、一番点数の高い商品を選びます。');
  const opts = {
    posted,
    cfg: config.rakuten,
    repostAfterDays: config.posting.repost_after_days,
    now,
    ...(prime ? { random: () => 0 } : {}),
  };
  // 今回の担当グループ・ジャンルから探し、見つからなければ次のグループも順に試す
  const groups = inSeason(config.genres, now);
  const forced = process.env.GROUP && groups.find((g) => g.label === process.env.GROUP);
  if (process.env.GROUP && !forced) throw new Error(`グループ「${process.env.GROUP}」が config.json にありません`);
  const first = forced ? genreFor(posted, [forced]) : genreFor(posted, groups);
  const start = groups.indexOf(first.group);
  for (let i = 0; i < groups.length; i++) {
    const group = groups[(start + i) % groups.length];
    const genre = i === 0 ? first.genre : genreFor(posted, [group]).genre;
    console.log(`「${group.label}」の「${genre.name}」(${genre.id}) のセール品を検索中…`);
    // 楽天の標準順と、報酬率の高い順の両方から候補を集める
    const candidates = [
      ...(await searchSaleItems(genre, config.rakuten, ctx)),
      ...(await searchSaleItems(genre, config.rakuten, ctx, { sort: '-affiliateRate' })),
    ];
    let item = pick(candidates, opts);
    if (!item) {
      console.log('条件に合うセール品がないので、ランキングから探します。');
      item = pick(await ranking(genre, config.rakuten, ctx), opts);
    }
    if (item) return { item, group, genre };
  }
  throw new Error('投稿できる商品が見つかりませんでした');
}

// 体験メモの商品のグループ（experience.group は config.json の genres の label。担当ジャンル外は使わない）
function groupForExperience(config, experience) {
  const group = config.genres.find((g) => g.label === experience.group);
  return { group, genre: { id: group.items[0].id, name: group.label } };
}

// A：セール速報型 / B：実体験レビュー型（1商品を親投稿＋リンクのリプライで紹介する）
async function postItem(env, { type, item, experience }) {
  const { config, posted, now, dryRun, userId, token } = env;
  const posting = config.posting;
  let group;
  let genre;
  if (item) ({ group, genre } = groupForExperience(config, experience));
  else ({ item, group, genre } = await findItem(env));

  // セールの名前と期間。ショップのタイムセールは名前を本文に入れず、期間の行だけ付ける
  const info = saleInfo({ sale: env.sale, boost: env.boost ? config.campaign.boost_days : null, item, now });
  const named = info && info.name !== 'ショップのセール' ? info : null;

  // 投稿文（親投稿の本文＋リプライの一言）：AI で書き、使えないときは定型文
  let post = null;
  if (process.env.ANTHROPIC_API_KEY) {
    try {
      // 直近の投稿のつかみ（1行目）を渡して、同じ出だしが続かないようにする
      const recentHooks = posted.slice(-8).map((p) => p.hook).filter(Boolean);
      const recentStyles = posted.slice(-8).map((p) => p.hook_style).filter(Boolean);
      post = await writePost(item, {
        groupLabel: group.label,
        genreName: genre.name,
        now,
        persona: config.persona,
        recentHooks,
        recentStyles,
        type,
        sale: named,
        experience,
      });
    } catch (e) {
      console.log(`AIで投稿文を作れなかったため、定型文を使います：${e.message}`);
    }
  } else {
    console.log('ANTHROPIC_API_KEY がないため、定型文を使います。');
  }
  const source = post ? 'AI' : '定型文';
  post ??=
    type === 'B'
      ? reviewTemplatePost(experience, { template: config.persona.template })
      : templatePost(item, { groupLabel: group.label, template: config.persona.template, now, sale: named });

  const tag = posting.use_topic_tag ? group.tag || posting.topic_tag : null;
  // 決まった行：B型は「いまの価格」、セール連動ならセール名と期間
  const extra = [type === 'B' ? priceLine(item, now) : null, info?.line];
  const parentText = buildParent(post.parent, { tag, notice: group.notice, extra });
  const replyText = buildReply({ hook: post.reply, notice: group.notice });
  console.log(`---- 親投稿（${type}型・${source}） ----\n${parentText}\n画像（${item.images.length}枚）: ${item.images.join(' ')}`);
  console.log(`---- リプライ ----\n${replyText}\nリンクカード: ${item.url}\n----------------`);

  if (dryRun) {
    console.log('DRY_RUN のため投稿はしていません。');
    return;
  }

  // 商品紹介は、画像を付けられなければ投稿しない（テキストだけの投稿は商品が伝わらない。2026-11-16 P01）
  let parent;
  try {
    parent = await publishParent({ userId, text: parentText, imageUrls: item.images, token, textOnly: posting.text_only_fallback ?? false });
  } catch (e) {
    if (!(e instanceof NoImageError)) throw e;
    console.log(`${e.message}（次の時間帯は通常どおり投稿します）`);
    return;
  }
  console.log(`親投稿を公開しました: ${parent.permalink}`);
  const record = {
    itemCode: item.itemCode,
    genre: group.label,
    price: item.price,
    postedAt: now.toISOString(),
    textSource: source,
    hook: firstLine(post.parent),
    ...(post.hookStyle ? { hook_style: post.hookStyle } : {}),
    ...logFields({ type, text: parentText, sale: info, mediaCount: parent.mediaCount }),
    threadsId: parent.id,
    permalink: parent.permalink,
    url: item.url,
    replyText,
    replyPending: true,
  };
  posted.push(record);
  await savePosted(posted);

  // 親投稿の処理が落ち着くまで少し待ってから、リンクをリプライで付ける
  const [minWait, maxWait] = posting.reply_wait_seconds;
  const wait = randomBetween(minWait, maxWait) * 1000;
  console.log(`${Math.round(wait / 1000)}秒待ってから、リンクをリプライで付けます。`);
  await sleep(wait);
  const reply = await publishReply({ userId, parentId: parent.id, text: replyText, link: item.url, token });
  Object.assign(record, { replyId: reply.id, replyPending: false });
  await savePosted(posted);
  console.log(`リプライを公開しました: ${reply.permalink}`);
}

// 商品リンクのない投稿（C型のカレンダー・D型の質問）を公開して記録する
async function publishPlain(env, { type, kind, text, imageUrls = [], extraRecord = {} }) {
  const { posted, now, dryRun, userId, token } = env;
  console.log(`---- 投稿（${type}型${kind ? `・${kind}` : ''}） ----\n${text}\n画像: ${imageUrls.join(' ') || 'なし'}\n----------------`);
  if (dryRun) {
    console.log('DRY_RUN のため投稿はしていません。');
    return;
  }
  const post = await publishParent({ userId, text, imageUrls, token });
  console.log(`投稿を公開しました: ${post.permalink}`);
  posted.push({
    postedAt: now.toISOString(),
    textSource: '定型文',
    hook: firstLine(text),
    ...logFields({ type, kind, text, sale: null, mediaCount: post.mediaCount }),
    ...extraRecord,
    threadsId: post.id,
    permalink: post.permalink,
  });
  await savePosted(posted);
}

// C：月初のセールカレンダー
async function postCalendar(env) {
  const { config, now } = env;
  const { text, eventCount } = calendarPost({
    periods: config.campaign.periods,
    extra: await readData('sale_calendar.json'),
    boostDays: config.campaign.boost_days,
    now,
    closing: config.templates?.C?.calendar_closing,
  });
  console.log(`カレンダーに載せるセール：${eventCount}件`);
  return publishPlain(env, { type: 'C', kind: 'calendar', text });
}

// C：月末のまとめ。紹介した商品を取り直して（いまの価格・評価）上位を並べる。足りなければ false（A型にする）
async function postTop(env) {
  const { config, posted, now, dryRun, userId, token, ctx, experiences } = env;
  const t = config.templates?.C || {};
  const codes = itemsThisMonth(posted, now).slice(0, 15);
  const items = [];
  for (const p of codes) {
    const it = await itemByCode(p.itemCode, config.rakuten, ctx).catch(() => null);
    if (it) items.push(it);
  }
  const top = rankForTop(items, t.top_count ?? 5);
  if (top.length < (t.top_min ?? 3)) {
    console.log(`まとめに使える商品が${top.length}件しかないので、A型にします。`);
    return false;
  }
  const { text, tried } = topPost(top, { now, experiences, closing: t.top_closing });
  const parentText = buildParent(text, {});
  const images = top.map((it) => it.images[0]).filter(Boolean);
  const replies = top.map((it, i) => ({ text: `${i + 1}位 ${cleanName(it.name, 24)}\n【PR】商品ページはこちら👇`, link: it.url }));
  console.log(`---- 親投稿（C型・top${tried ? '・体験メモあり' : ''}） ----\n${parentText}\n画像（${images.length}枚）: ${images.join(' ')}`);
  for (const r of replies) console.log(`---- リプライ ----\n${r.text}\nリンクカード: ${r.link}`);
  if (dryRun) {
    console.log('DRY_RUN のため投稿はしていません。');
    return true;
  }
  const parent = await publishParent({ userId, text: parentText, imageUrls: images, token });
  console.log(`親投稿を公開しました: ${parent.permalink}`);
  const record = {
    postedAt: now.toISOString(),
    textSource: '定型文',
    hook: firstLine(text),
    ...logFields({ type: 'C', kind: 'top', text: parentText, sale: null, mediaCount: parent.mediaCount }),
    itemCodes: top.map((it) => it.itemCode),
    threadsId: parent.id,
    permalink: parent.permalink,
    replyIds: [],
  };
  posted.push(record);
  await savePosted(posted);
  const [minWait] = config.posting.reply_wait_seconds;
  for (const r of replies) {
    await sleep(minWait * 1000);
    try {
      const reply = await publishReply({ userId, parentId: parent.id, text: r.text, link: r.link, token });
      record.replyIds.push(reply.id);
      await savePosted(posted);
      console.log(`リプライを公開しました: ${reply.permalink}`);
    } catch (e) {
      console.log(`リプライに失敗しました（${r.text.split('\n')[0]}）：${e.message}`);
    }
  }
  return true;
}

// D：デスク写真の相談投稿（商品リンクなし）
async function postQuestion(env, photo) {
  const text = questionPost(photo, { questions: env.config.templates?.D?.questions });
  if (!/\d/.test(text.split('\n').slice(0, 2).join(''))) {
    console.log('注意：D型の冒頭2行に数字がありません（data/desk_photos.json の memo に「デスク歴3年」などの数字を入れると、ルールどおりになります）。');
  }
  return publishPlain(env, { type: 'D', text, imageUrls: [photo.image_url], extraRecord: { photo: photo.image_url } });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
