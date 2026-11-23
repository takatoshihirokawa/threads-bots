import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalize, largeImage } from '../src/rakuten.js';
import { pick, genreFor, parseJst } from '../src/select.js';
import { templatePost, buildParent, buildReply, cleanName } from '../src/compose.js';
import { checkPost, splitPost, buildSystemPrompt, facts, hookHead, stripSale, hookStyleFor } from '../src/writer.js';
import { readFileSync } from 'node:fs';

const config = JSON.parse(readFileSync(new URL('../accounts/neko/config.json', import.meta.url)));
const persona = config.persona;
import { inCampaign, isBoostDay, postsToday, scheduleDelayMinutes } from '../src/post.js';

const cfg = { min_review_count: 20, min_review_average: 3.8 };
const now = new Date('2026-10-06T12:00:00+09:00');

const raw = (over = {}) => ({
  itemCode: 'shop:item1',
  itemName: '【送料無料】★楽天1位★ 洗濯洗剤 詰め替え 超特大 6個セット【クーポンで半額】',
  itemPrice: 2980,
  affiliateUrl: 'https://hb.afl.rakuten.co.jp/hgc/xxx',
  itemUrl: 'https://item.rakuten.co.jp/shop/item1/',
  mediumImageUrls: ['https://thumbnail.image.rakuten.co.jp/@0_mall/shop/cabinet/a.jpg?_ex=128x128'],
  reviewCount: 1234,
  reviewAverage: 4.62,
  pointRate: 5,
  postageFlag: 0,
  startTime: '2026-10-05 20:00',
  endTime: '2026-10-08 01:59',
  availability: 1,
  ...over,
});

test('normalize: v1/v2 どちらの形も読める', () => {
  const v2 = normalize(raw());
  const v1 = normalize({ item: raw({ mediumImageUrls: [{ imageUrl: 'https://thumbnail.image.rakuten.co.jp/a.jpg?_ex=128x128' }] }) });
  assert.equal(v2.url, 'https://hb.afl.rakuten.co.jp/hgc/xxx');
  assert.equal(v2.postageIncluded, true);
  assert.match(v2.image, /_ex=600x600/);
  assert.match(v1.image, /_ex=600x600/);
});

test('largeImage: _ex がなくても付ける', () => {
  assert.equal(largeImage('https://x.jp/a.jpg'), 'https://x.jp/a.jpg?_ex=600x600');
});

test('parseJst: 楽天の時刻を日本時間として読む', () => {
  assert.equal(parseJst('2026-10-08 01:59').toISOString(), '2026-10-07T16:59:00.000Z');
});

test('pick: 投稿済み・レビュー不足・終了間近を除く', () => {
  const a = normalize(raw({ itemCode: 'a' }));
  const fewReviews = normalize(raw({ itemCode: 'b', reviewCount: 3 }));
  const endingSoon = normalize(raw({ itemCode: 'c', endTime: '2026-10-06 12:30' }));
  const posted = [{ itemCode: 'a', postedAt: '2026-10-01T00:00:00Z' }];
  assert.equal(pick([a, fewReviews, endingSoon], { posted, cfg, repostAfterDays: 30, now }), null);
  const ok = pick([a], { posted: [], cfg, repostAfterDays: 30, now });
  assert.equal(ok.itemCode, 'a');
  // 30日以上前の投稿なら再投稿してよい
  const old = [{ itemCode: 'a', postedAt: '2026-08-01T00:00:00Z' }];
  assert.equal(pick([a], { posted: old, cfg, repostAfterDays: 30, now }).itemCode, 'a');
});

test('genreFor: グループを回し、グループ内のジャンルも回す', () => {
  const groups = [
    { label: 'A', items: [{ id: 1 }, { id: 2 }] },
    { label: 'B', items: [{ id: 3 }] },
  ];
  assert.equal(genreFor([], groups).genre.id, 1);
  assert.equal(genreFor([{ genre: 'A' }], groups).genre.id, 3);
  assert.equal(genreFor([{ genre: 'A' }, { genre: 'B' }], groups).genre.id, 2);
});

test('pick: 効果をうたう商品名は除く', () => {
  const ng = normalize(raw({ itemCode: 'x', itemName: '育毛シャンプー 詰め替え' }));
  const c = { ...cfg, ng_name_pattern: '育毛|美白' };
  assert.equal(pick([ng], { posted: [], cfg: c, repostAfterDays: 30, now }), null);
});

test('cleanName: 宣伝文句を削って短くする', () => {
  assert.equal(cleanName(raw().itemName), '楽天1位 洗濯洗剤 詰め替え 超特大 6個セット');
  assert.equal(cleanName('≪20%OFFクーポン 10日23:59迄≫ケトル 保温 1L'), 'ケトル 保温 1L');
});

test('cleanName: 長い商品名は区切りで切る', () => {
  const name = '丈夫で長持ち 極厚 両面ダイヤグリップ ニトリル グローブ M L 整備 50枚 500枚 ニトリル手袋 使い捨て';
  assert.equal(cleanName(name), '丈夫で長持ち 極厚 両面ダイヤグリップ ニトリル グローブ M L 整備 50枚 500枚…');
});


test('inCampaign: 期間内だけ true', () => {
  const periods = [{ name: 'マラソン', start: '2026-10-04T20:00', end: '2026-10-11T01:59' }];
  assert.equal(inCampaign(periods, now).name, 'マラソン');
  assert.equal(inCampaign(periods, new Date('2026-10-12T00:00:00+09:00')), undefined);
});

import { parsePeriods, mergePeriods } from '../src/update-campaigns.js';

test('parsePeriods: 楽天の日程表記を読み取る', () => {
  const html = `<p>2026年10月4日(日) 20:00 ～ 2026年10月9日(金) 01:59</p>
    <p>2026年12月29日（火）20:00〜1月3日（日）9:59</p>
    <p>エントリー 2026年9月1日(火) 10:00 ～ 2026年10月31日(土) 23:59</p>`;
  assert.deepEqual(parsePeriods(html, 'M'), [
    { name: 'M', start: '2026-10-04T20:00', end: '2026-10-09T01:59' },
    { name: 'M', start: '2026-12-29T20:00', end: '2027-01-03T09:59' },
  ]);
});

test('mergePeriods: 追加・重複排除し、終わって7日たった期間は消す', () => {
  const current = [
    { name: '古い', start: '2026-09-01T20:00', end: '2026-09-05T01:59' },
    { name: '手入力の名前', start: '2026-10-04T20:00', end: '2026-10-09T01:59' },
  ];
  const incoming = [
    { name: 'M', start: '2026-10-04T20:00', end: '2026-10-09T01:59' },
    { name: 'M', start: '2026-10-14T20:00', end: '2026-10-17T09:59' },
  ];
  const merged = mergePeriods(current, incoming, now);
  assert.deepEqual(merged.map((p) => p.name), ['手入力の名前', 'M']);
});

test('templatePost + buildParent: 3行以内・リンクなし・PRあり・タグなし', () => {
  const post = templatePost(normalize(raw()), { groupLabel: '日用品', template: persona.template, now, random: () => 0 });
  assert.equal(post.parent.split('\n').length, 3);
  // 1行目：数字（ポイント倍率）、2行目：商品名＋価格
  // 1行目：場面から入る一言（empathy）、2行目：商品名＋価格＋ポイント倍率（2026-11-23 P01）
  assert.doesNotMatch(post.parent.split('\n')[0], /\d/);
  assert.match(post.parent.split('\n')[1], /2,980円・ポイント5倍/);
  assert.equal(post.hookStyle, '場面');
  const sale = { name: 'お買い物マラソン 10月第1弾' };
  const withSale = templatePost(normalize(raw()), { groupLabel: '日用品', template: persona.template, now, random: () => 0, sale });
  assert.match(withSale.parent.split('\n')[1], /^お買い物マラソン 10月第1弾中、.*2,980円・ポイント5倍$/);
  assert.doesNotMatch(withSale.parent.split('\n')[0], /お買い物マラソン/);
  const text = buildParent(post.parent, {});
  assert.ok(!text.includes('http'));
  assert.match(text, /\nPR$/);
  assert.ok(!text.includes('#'));
  assert.match(buildParent(post.parent, { tag: '日用品' }), /#日用品$/);
  console.log('\n' + text + '\n---\n' + buildReply({ hook: post.reply }));
});

test('buildParent / buildReply: 一言＋PR、お酒の注意書きを両方に入れる', () => {
  const notice = '※20歳未満の飲酒は法律で禁止されています';
  assert.match(buildParent('本文', { notice }), /20歳未満/);
  const reply = buildReply({ hook: '6缶でこの価格はうれしい', notice });
  assert.deepEqual(reply.split('\n'), ['6缶でこの価格はうれしい', '【PR】商品ページはこちら👇', notice]);
});

test('checkPost: AIの文のルール違反を見つける', () => {
  const item = normalize(raw());
  const ok = { parent: 'え、待って。洗剤の詰め替え6個セット。\n重いしかさばるのに、玄関まで届くのは助かる。\n2,980円で送料無料。', reply: 'この量でこの価格はうれしい😋' };
  const p = (over) => ({ ...ok, ...over });
  assert.equal(checkPost(ok, item), null);
  assert.match(checkPost(null, item), /分かれていない/);
  assert.match(checkPost(p({ parent: ok.parent + '\n4行目' }), item), /4行/);
  assert.match(checkPost(p({ reply: 'あ'.repeat(41) }), item), /リプライの一言が長い/);
  assert.match(checkPost(p({ reply: '急いで！' }), item), /禁止表現/);
  assert.match(checkPost(p({ parent: '【速報】' + ok.parent }), item), /禁止表現/);
  assert.match(checkPost(p({ parent: '知らないと損します。' + ok.parent }), item), /禁止表現/);
  assert.match(checkPost(p({ parent: ok.parent.replace('2,980円', '1,980円') }), item), /データにない数字/);
  assert.match(checkPost(p({ reply: '8個でこの価格' }), item), /データにない数字/);
  assert.match(checkPost(p({ reply: 'コスパ最強！' }), item, { extraBanned: ['コスパ最強'] }), /禁止表現/);
  assert.match(checkPost(p({ reply: 'ドラッグストアより安い' }), item), /禁止表現/);
  assert.match(checkPost(p({ reply: '使ってみたら最高' }), item), /禁止表現/);
  assert.match(checkPost(p({ reply: '体にいいよ' }), item), /禁止表現/);
  assert.match(checkPost(p({ parent: '短い' }), item), /文字数/);
});

test('splitPost: 「---」で親投稿とリプライに分ける', () => {
  assert.deepEqual(splitPost('1行目\n2行目\n---\n一言'), { parent: '1行目\n2行目', reply: '一言' });
  assert.equal(splitPost('区切りなし'), null);
});

test('postsToday: 日本時間の今日の投稿数を数える', () => {
  const posted = [
    { postedAt: '2026-10-05T14:59:00Z' }, // 10/5 23:59 JST
    { postedAt: '2026-10-05T15:00:00Z' }, // 10/6 0:00 JST
    { postedAt: '2026-10-06T02:00:00Z' },
  ];
  assert.equal(postsToday(posted, now), 2);
});

import { writePost } from '../src/writer.js';

test('writePost: AIへの依頼内容と、結果の取り出し・不合格時の扱い', async () => {
  const item = normalize(raw());
  const good = '洗剤の詰め替え6個セット、ストック切れてない？\n重いしかさばるのに、玄関まで届くのは助かる。\n2,980円で送料無料。\n---\nこの量でこの価格はうれしい😋';
  // 直近のつかみがないときは問いかけ型（2026-11-09 P02）。結果に つかみの型 が付く
  const goodPost = { ...splitPost(good), hookStyle: '問いかけ' };
  let request;
  const fake = (text, stop_reason = 'end_turn') => ({
    beta: { messages: { create: async (req) => { request = req; return { stop_reason, content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }] }; } } },
  });
  const ctx = { groupLabel: '日用品', genreName: '洗剤・柔軟剤', now, persona: { ...persona, must_include: null } };
  assert.deepEqual(await writePost(item, ctx, { client: fake(good) }), goodPost);
  assert.equal(request.model, 'claude-sonnet-5-5');
  assert.equal(request.fallbacks, 'default');
  assert.match(request.messages[0].content, /2,980円/);
  assert.match(request.system, /3行以内/);
  assert.equal(await writePost(item, ctx, { client: fake('今すぐ急げ！' + good) }), null);
  // 1回目が不合格でも、書き直しが合格なら使う
  let calls = 0;
  const retry = { beta: { messages: { create: async (req) => {
    calls++; request = req;
    return { stop_reason: 'end_turn', content: [{ type: 'text', text: calls === 1 ? '今すぐ急げ！' + good : good }] };
  } } } };
  assert.deepEqual(await writePost(item, ctx, { client: retry }), goodPost);
  assert.equal(calls, 2);
  assert.match(request.messages.at(-1).content, /ルール違反/);
  assert.equal(await writePost(item, ctx, { client: fake(good, 'refusal') }), null);
});

test('checkPost: スペックの数字は商品説明にあれば使える', () => {
  const item = normalize(raw({ itemName: 'USB-C 充電器 65W 3ポート', itemPrice: 3990, itemCaption: '最大出力65W、USB-C×2、USB-A×1。重さ約120g。' }));
  const ft = JSON.stringify(facts(item, { groupLabel: '充電', genreName: 'AC式充電器', now, persona: { use_spec: true } }));
  const post = { parent: 'え、充電器ってこれ1個でいいの？\n65Wで3ポート、ノートPCもスマホもまとめて充電。\n重さは約120g。', reply: '3,990円で送料無料' };
  assert.equal(checkPost(post, item, { factsText: ft }), null);
  assert.match(checkPost({ ...post, parent: post.parent.replace('120g', '100g') }, item, { factsText: ft }), /データにない数字（100）/);
});

test('presets: 3テーマの設定が読み込めて、指示文が作れる', () => {
  for (const name of ['desk', 'audio', 'kaden']) {
    const c = JSON.parse(readFileSync(new URL(`../presets/${name}.json`, import.meta.url)));
    assert.equal(c.paused, true);
    assert.ok(c.genres.length > 0 && c.genres.every((g) => g.items.length > 0 && c.persona.template.empathy[g.label]));
    const prompt = buildSystemPrompt(c.persona);
    assert.match(prompt, /商品説明にあるスペック/);
    assert.match(prompt, /体験談/);
    const post = templatePost(normalize(raw()), { groupLabel: c.genres[0].label, template: c.persona.template, now, random: () => 0 });
    assert.ok(post.parent.split('\n').length <= 3 && post.reply.length > 0);
    assert.equal(c.posting.use_topic_tag, false);
    assert.deepEqual(c.campaign.boost_days.days, [5, 10, 15, 20, 25, 30]);
  }
});

test('inSeason: months の月だけジャンルを使い、空のグループは外す', async () => {
  const { inSeason } = await import('../src/select.js');
  const groups = [
    { label: 'A', items: [{ id: 1 }] },
    { label: 'B', items: [{ id: 2, months: [10, 11] }, { id: 3, months: [6] }] },
    { label: 'C', items: [{ id: 4, months: [6] }] },
  ];
  // 2026-09-30T16:00Z は日本時間で 10/1
  const oct = inSeason(groups, new Date('2026-09-30T16:00:00Z'));
  assert.deepEqual(oct.map((g) => g.label), ['A', 'B']);
  assert.deepEqual(oct[1].items.map((i) => i.id), [2]);
  assert.deepEqual(inSeason(groups, new Date('2026-06-15T00:00:00Z')).map((g) => g.items.length), [1, 1, 1]);
});

test('checkPost: キャラの口癖が足りなければ不合格（親投稿とリプライの合計）', () => {
  const item = normalize(raw());
  const post = { parent: '洗剤の詰め替え6個、重いしかさばるにゃ。\n玄関まで届くのは助かるにゃん。\n2,980円で送料無料。', reply: 'この量でこの価格はうれしいにゃ😋' };
  const rule = { pattern: 'にゃ', min: 3 };
  assert.equal(checkPost(post, item, { mustInclude: rule }), null);
  assert.match(checkPost({ ...post, reply: 'うれしい' }, item, { mustInclude: rule }), /「にゃ」が2回/);
});

test('isBoostDay: 5と0のつく日とその前日', () => {
  const boost = { days: [5, 10, 15, 20, 25, 30], include_day_before: true };
  const jst = (d) => new Date(`${d}T12:00:00+09:00`);
  assert.equal(isBoostDay(boost, jst('2026-10-05')), true);
  assert.equal(isBoostDay(boost, jst('2026-10-04')), true);
  assert.equal(isBoostDay(boost, jst('2026-10-06')), false);
  assert.equal(isBoostDay({ ...boost, include_day_before: false }, jst('2026-10-09')), false);
  assert.equal(isBoostDay(undefined, jst('2026-10-05')), false);
});

test('normalize: 画像を最大3枚まで大きいサイズで持つ', () => {
  const item = normalize(raw({ mediumImageUrls: ['https://x.jp/a.jpg?_ex=128x128', 'https://x.jp/b.jpg?_ex=128x128', 'https://x.jp/c.jpg?_ex=128x128'] }));
  assert.equal(item.images.length, 3);
  assert.ok(item.images.every((u) => u.includes('_ex=600x600')));
  assert.equal(item.image, item.images[0]);
});

test('checkPost: 最近の投稿と同じ出だしのつかみは不合格', () => {
  const item = normalize(raw());
  const post = { parent: 'え、待って。洗剤の詰め替え6個セット。\n玄関まで届くのは助かる。\n2,980円で送料無料。', reply: 'この量でこの価格はうれしい😋' };
  const recent = ['え、待って！これ便利すぎ', 'これって私だけ？'];
  assert.match(checkPost(post, item, { recentHooks: recent }), /最近の投稿と同じ出だし/);
  assert.equal(checkPost({ ...post, parent: post.parent.replace('え、待って。', 'ねえ、ちょっといい？') }, item, { recentHooks: recent }), null);
  assert.equal(hookHead('え、待って。😳'), 'え待って');
});

test('facts: 最近使ったつかみをAIに渡す', () => {
  const f = facts(normalize(raw()), { groupLabel: '日用品', genreName: '洗剤', now, recentHooks: ['え、待って。'] });
  assert.deepEqual(f.最近使ったつかみ, ['え、待って。']);
});

test('scheduleDelayMinutes: 定期実行の遅れ（分）を求める', () => {
  // 予定 14:20 UTC（日本時間 23:20）→ 19:35 UTC に開始：315分遅れ
  assert.equal(scheduleDelayMinutes('20 14 * * *', new Date('2026-10-06T19:35:00Z')), 315);
  // 予定どおり数分遅れ
  assert.equal(scheduleDelayMinutes('14 22 * * 0-4', new Date('2026-10-06T22:19:00Z')), 5);
  // 日付をまたいだ遅れ（予定 22:14 UTC → 翌 0:44 UTC）
  assert.equal(scheduleDelayMinutes('14 22 * * 0-4', new Date('2026-10-07T00:44:00Z')), 150);
  // cron がない（手動実行）ときは判定しない
  assert.equal(scheduleDelayMinutes('', new Date()), null);
});

import { slotForNow, postedThisHour } from '../src/post.js';

test('slotForNow: 平日・休日・推し枠・追加枠を日本時間で判断する', () => {
  const slots = { weekday: [7, 12, 18, 20, 22], weekend: [9, 15, 18, 20, 22], campaign_extra: [10, 21], prime_hour: 20 };
  const at = (s) => new Date(`${s}+09:00`);
  assert.equal(slotForNow(slots, at('2026-10-07T07:10:00')), 'regular'); // 水曜
  assert.equal(slotForNow(slots, at('2026-10-07T09:10:00')), null); // 平日の9時は枠なし
  assert.equal(slotForNow(slots, at('2026-10-07T20:10:00')), 'prime');
  assert.equal(slotForNow(slots, at('2026-10-07T21:10:00')), 'campaign');
  assert.equal(slotForNow(slots, at('2026-10-10T09:10:00')), 'regular'); // 土曜
  assert.equal(slotForNow(slots, at('2026-10-10T07:10:00')), null); // 休日の7時は枠なし
  assert.equal(slotForNow(slots, at('2026-10-11T15:10:00')), 'regular'); // 日曜
});

test('postedThisHour: 同じ日・同じ時（日本時間）の投稿があれば true', () => {
  const posted = [{ postedAt: '2026-10-07T11:05:00Z' }]; // 20:05 JST
  assert.equal(postedThisHour(posted, new Date('2026-10-07T20:40:00+09:00')), true);
  assert.equal(postedThisHour(posted, new Date('2026-10-07T21:05:00+09:00')), false);
  assert.equal(postedThisHour(posted, new Date('2026-10-08T20:05:00+09:00')), false);
});

test('publishReply: Media Not Found のときは待って作り直す（すでに付いていれば作らない）', async () => {
  const { publishReply } = await import('../src/threads.js');
  const realFetch = globalThis.fetch;
  const reply = (body) => ({ ok: true, status: 200, json: async () => body });
  const notFound = { ok: false, status: 400, json: async () => ({ error: { code: 24, error_subcode: 4279009, error_user_title: 'Media Not Found', is_transient: false } }) };
  const run = async (existingReplies) => {
    const calls = [];
    let publishCount = 0;
    globalThis.fetch = async (url, opts) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/threads_publish')) return ++publishCount === 1 ? notFound : reply({ id: 'R2' });
      if (u.includes('/replies')) return reply({ data: existingReplies });
      if (u.includes('/me/threads')) return reply({ id: `C${calls.length}` });
      if (u.includes('fields=status')) return reply({ status: 'FINISHED' });
      return reply({ permalink: 'https://www.threads.com/p/R2' });
    };
    try {
      return { result: await publishReply({ parentId: 'P1', text: '一言\n【PR】', link: 'https://example.com', token: 't', retryWait: 0 }), publishCount };
    } finally {
      globalThis.fetch = realFetch;
    }
  };
  const fresh = await run([]);
  assert.equal(fresh.result.id, 'R2');
  assert.equal(fresh.publishCount, 2);
  const already = await run([{ id: 'R1', text: '一言\n【PR】', permalink: 'https://www.threads.com/p/R1' }]);
  assert.equal(already.result.id, 'R1');
  assert.equal(already.publishCount, 1);
});

// ---- 投稿の型（A／B／C／D） ----
import {
  chooseTemplate,
  saleInfo,
  priceLine,
  calendarPost,
  rankForTop,
  topPost,
  questionPost,
  logFields,
  postsSince,
} from '../src/templates.js';
import { reviewTemplatePost } from '../src/compose.js';
import { summarize, selfReplies } from '../src/report.js';

const rec = (over = {}) => ({ itemCode: 'x', postedAt: '2026-10-20T03:00:00Z', template_type: 'A', ...over });

test('chooseTemplate: ふだんは A。体験メモがあれば3本に1回 B', () => {
  const t = config.templates;
  const mid = new Date('2026-10-15T12:00:00+09:00');
  assert.equal(chooseTemplate({ posted: [], templates: t, now: mid }).type, 'A');
  const exp = [{ itemCode: 'shop:1', group: '日用品', used_for: '3か月', good: ['軽い'], bad: '色が少ない' }];
  assert.equal(chooseTemplate({ posted: [], templates: t, now: mid, experiences: exp }).type, 'B');
  const justB = [rec({ template_type: 'B', itemCode: 'shop:2' })];
  assert.equal(chooseTemplate({ posted: justB, templates: t, now: mid, experiences: exp }).type, 'A');
  const later = [...justB, rec(), rec()];
  assert.equal(chooseTemplate({ posted: later, templates: t, now: mid, experiences: exp }).type, 'B');
  // 同じ体験メモは repost_after_days の間は使わない
  const used = [rec({ template_type: 'B', itemCode: 'shop:1', postedAt: '2026-10-10T00:00:00Z' }), rec(), rec()];
  assert.equal(chooseTemplate({ posted: used, templates: t, now: mid, experiences: exp }).type, 'A');
});

test('chooseTemplate: 月初はカレンダー、月末は（3件以上紹介していれば）まとめ。どちらも月1回', () => {
  const t = config.templates;
  const first = new Date('2026-11-01T07:10:00+09:00');
  assert.deepEqual(chooseTemplate({ posted: [], templates: t, now: first }), { type: 'C', kind: 'calendar' });
  const done = [rec({ template_type: 'C', template_kind: 'calendar', itemCode: undefined, postedAt: '2026-10-31T22:10:00Z' })];
  assert.equal(chooseTemplate({ posted: done, templates: t, now: first }).type, 'A');
  const last = new Date('2026-10-31T12:00:00+09:00');
  assert.equal(chooseTemplate({ posted: [rec()], templates: t, now: last }).type, 'A');
  const three = ['a', 'b', 'c'].map((c) => rec({ itemCode: c }));
  assert.deepEqual(chooseTemplate({ posted: three, templates: t, now: last }), { type: 'C', kind: 'top' });
});

test('chooseTemplate: D は有効で写真があるときだけ、5本に1回。古い写真から使う', () => {
  const t = { ...config.templates, D: { enabled: true, every: 5 } };
  const mid = new Date('2026-10-15T12:00:00+09:00');
  const photos = [{ image_url: 'https://x/1.jpg' }, { image_url: 'https://x/2.jpg' }];
  assert.equal(chooseTemplate({ posted: [], templates: { ...t, D: { enabled: false } }, now: mid, photos }).type, 'A');
  const d = chooseTemplate({ posted: [], templates: t, now: mid, photos });
  assert.equal(d.type, 'D');
  const afterD = [rec({ template_type: 'D', photo: 'https://x/1.jpg' }), rec(), rec(), rec()];
  assert.equal(chooseTemplate({ posted: afterD, templates: t, now: mid, photos }).type, 'A');
  const again = chooseTemplate({ posted: [...afterD, rec()], templates: t, now: mid, photos });
  assert.equal(again.photo.image_url, 'https://x/2.jpg');
  assert.equal(postsSince(afterD, 'D'), 3);
});

test('saleInfo: セール名と期間の行（マラソン → 5と0のつく日 → ショップのセール）', () => {
  const at = new Date('2026-10-24T21:00:00+09:00');
  const sale = { name: 'お買い物マラソン 10月第3弾', start: '2026-10-24T20:00', end: '2026-10-27T09:59' };
  assert.equal(saleInfo({ sale, now: at }).line, '🗓 お買い物マラソン 10月第3弾：10/24 20:00〜10/27 9:59');
  const boost = { days: [5, 10, 15, 20, 25, 30] };
  assert.equal(saleInfo({ boost, now: new Date('2026-10-29T12:00:00+09:00') }).line, '🗓 楽天 5と0のつく日：10/30 0:00〜23:59');
  const item = normalize(raw());
  assert.match(saleInfo({ item, now }).line, /ショップのセール：10\/5 20:00〜10\/8 1:59まで/);
  assert.equal(saleInfo({ item: normalize(raw({ endTime: '' })), now }), null);
});

test('checkPost: A型は冒頭2行に数字、セール中は1行目にセール名、抽象的な締めは不合格', () => {
  const item = normalize(raw());
  const factsText = JSON.stringify({ セール名: 'お買い物マラソン 10月第3弾', 価格: '2,980円', ポイント倍率: '5倍' });
  const opts = { factsText, saleName: 'お買い物マラソン 10月第3弾' };
  const ok = { parent: 'お買い物マラソン中、ポイント5倍の洗剤みつけた\n詰め替え6個セットで2,980円\n重い詰め替えが玄関まで届くのは助かる', reply: 'サイズ感はこちらで見られるよ' };
  assert.equal(checkPost(ok, item, opts), null);
  assert.match(checkPost({ ...ok, parent: 'え、待って。洗剤の詰め替えがある\n重いしかさばるのに届く\n2,980円で送料無料' }, item, opts), /冒頭の2行に数字/);
  assert.match(checkPost({ ...ok, parent: 'ポイント5倍の洗剤みつけた\n詰め替え6個セットで2,980円\n重いけど届くのは助かる' }, item, opts), /セール名/);
  assert.match(checkPost({ ...ok, parent: 'お買い物マラソン中、ポイント5倍の洗剤\n詰め替え6個セットで2,980円\nこれはかなりお得！' }, item, opts), /抽象的/);
  // セール名は毎回同じなので、つかみの出だし比べでは除く
  const recentHooks = ['お買い物マラソン中、ポイント5倍の洗剤みつけた'];
  assert.match(checkPost(ok, item, { ...opts, recentHooks }), /同じ出だし/);
  assert.equal(checkPost(ok, item, { ...opts, recentHooks: ['お買い物マラソン中、2,980円のお米'] }), null);
});

test('checkPost: B型は5行まで・体験メモの言葉はよい。A型では体験談は不合格', () => {
  const item = normalize(raw());
  const factsText = JSON.stringify({ 体験メモ: { 使った期間: '3か月' }, 価格: '2,980円' });
  const post = { parent: '3か月使ってみた正直な感想\n詰め替えが軽くて楽\n香りが強めなのは微妙だった\n6個あると切らさない', reply: 'サイズ感はこちらで見られるよ' };
  assert.equal(checkPost(post, item, { factsText, type: 'B' }), null);
  assert.match(checkPost(post, item, { factsText, type: 'A' }), /行ある|禁止表現/);
  assert.match(checkPost({ ...post, parent: post.parent.replace('3か月', '半年') }, item, { factsText, type: 'B' }), /冒頭の2行に数字/);
});

test('buildSystemPrompt: B型は体験メモだけをもとに、A型は体験談を禁止', () => {
  assert.match(buildSystemPrompt(persona, 'B'), /体験メモに書いてあることだけ/);
  assert.match(buildSystemPrompt(persona, 'B'), /微妙だった点を必ず1つ/);
  assert.match(buildSystemPrompt(persona, 'A'), /あなたは商品を使っていない/);
  assert.match(buildSystemPrompt(persona, 'A'), /セール名/);
});

test('B型：定型文は体験メモをそのまま使い、末尾にいまの価格', () => {
  const exp = { used_for: '3か月', good: ['軽い', '静か'], bad: '色が少ない' };
  const post = reviewTemplatePost(exp, { template: persona.template, random: () => 0 });
  assert.deepEqual(post.parent.split('\n'), ['3か月使ってみての正直な感想', '良かった：軽い／静か', '微妙だった：色が少ない']);
  const item = normalize(raw());
  assert.match(priceLine(item, now), /^💰 いまの価格：2,980円（送料無料・ポイント5倍）　※10\/6 12:00時点$/);
  const text = buildParent(post.parent, { extra: [priceLine(item, now), '🗓 お買い物マラソン：10/24 20:00〜10/27 9:59'] });
  assert.match(text, /微妙だった：色が少ない\n\n💰 いまの価格.*\n🗓 お買い物マラソン.*\nPR$/);
});

test('C型：セールカレンダーは今月の予定だけを日付順に（推測で書かない）', () => {
  const periods = [
    { name: 'お買い物マラソン', start: '2026-11-04T20:00', end: '2026-11-11T01:59' },
    { name: 'お買い物マラソン', start: '2026-10-24T20:00', end: '2026-10-27T09:59' },
  ];
  const extra = [{ store: 'Amazon', name: 'ブラックフライデー', start: '2026-11-27T00:00', end: '2026-12-01T23:59', summary: '年末前の大型セール' }];
  const { text, eventCount } = calendarPost({ periods, extra, boostDays: config.campaign.boost_days, now: new Date('2026-11-01T07:00:00+09:00') });
  assert.equal(eventCount, 2);
  assert.match(text, /^📅 11月のセールカレンダー\n\n・楽天 お買い物マラソン　11\/4 20:00〜11\/11 1:59\n・Amazon ブラックフライデー　11\/27 0:00〜12\/1 23:59\n　年末前の大型セール\n・楽天 5と0のつく日　5・10・15・20・25・30日/);
  assert.ok(text.length <= 500);
});

test('C型：月末まとめは評価順。体験メモがない商品があれば「買ってよかった」と書かない', () => {
  const items = [
    normalize(raw({ itemCode: 'a', reviewAverage: 4.2 })),
    normalize(raw({ itemCode: 'b', reviewAverage: 4.8 })),
    normalize(raw({ itemCode: 'c', reviewAverage: 4.5, availability: 0 })),
  ];
  const top = rankForTop(items, 5);
  assert.deepEqual(top.map((i) => i.itemCode), ['b', 'a']);
  const at = new Date('2026-10-31T20:00:00+09:00');
  assert.match(topPost(top, { now: at }).text, /^🏆 10月に紹介した中で、レビュー評価が高かったTop2\n\n1位 .*\n　2,980円・★4.80（1,234件）/);
  const exps = [{ itemCode: 'a' }, { itemCode: 'b' }];
  assert.match(topPost(top, { now: at, experiences: exps }).text, /^🏆 10月に買ってよかったものTop2/);
  assert.ok(!topPost(top, { now: at, experiences: [{ itemCode: 'a' }] }).text.includes('買ってよかった'));
});

test('D型：メモ＋相談の一言', () => {
  assert.equal(questionPost({ memo: 'デスク歴3年。モニター2枚' }, { questions: ['あと何かいるかな？'] }), 'デスク歴3年。モニター2枚\nあと何かいるかな？');
});

test('logFields：効果測定の項目', () => {
  const f = logFields({ type: 'A', text: 'お買い物マラソン中、ポイント5倍\n洗剤 2,980円\n…', sale: { name: 'お買い物マラソン' }, mediaCount: 3 });
  assert.deepEqual(f, { template_type: 'A', has_price: true, has_discount_rate: true, number_in_head: true, sale_name: 'お買い物マラソン', has_media: true });
  assert.equal(logFields({ type: 'D', text: 'あと何かいるかな？', mediaCount: 0 }).has_price, false);
});

test('report: 型ごとに平均を出し、型のない投稿は「従来型」に分ける', () => {
  const m = (likes) => ({ likes, replies: 1, reposts: 0, quotes: 0, views: 100 });
  const rows = [
    { template_type: 'A', metrics: m(4) },
    { template_type: 'A', metrics: m(2) },
    { template_type: 'C', template_kind: 'calendar', metrics: m(10) },
    { metrics: m(1) },
  ];
  const s = summarize(rows);
  assert.deepEqual(s.map((r) => [r.key, r.count, r.engagement]), [['A', 2, 4], ['C（calendar）', 1, 11], ['従来型', 1, 2]]);
});

test('cleanName: 日付・ポイント・クーポンの宣伝文句を削る', () => {
  assert.equal(cleanName('10/30限定P2倍 サントリー 天然水 2L 9本'), 'サントリー 天然水 2L 9本');
  assert.equal(cleanName('お歳暮 早割 クーポン 冬ギフト 醤油 出汁'), 'お歳暮 冬ギフト 醤油 出汁');
});

test('report: 自分で付けたリンクのリプライの数', () => {
  assert.equal(selfReplies({ replyId: 'r1' }), 1);
  assert.equal(selfReplies({ replyIds: ['a', 'b', 'c'] }), 3);
  assert.equal(selfReplies({}), 0);
});

test('stripSale：出だし比べでセール名と続く言葉を除く（10/30 にAIの文が全部「同じ出だし」になった不具合）', () => {
  assert.equal(stripSale('5と0のつく日に、1,480円のベビーローション', '5と0のつく日'), '1,480円のベビーローション');
  assert.equal(stripSale('お買い物マラソン 10月第3弾中、ポイント5倍の洗剤', 'お買い物マラソン 10月第3弾'), 'ポイント5倍の洗剤');
  const item = normalize(raw({ itemName: 'ベビーローション 300ml', itemPrice: 1480 }));
  const factsText = JSON.stringify({ セール名: '5と0のつく日', 価格: '1,480円' });
  const post = { parent: '5と0のつく日に、1,480円のローション見つけたにゃ\nベビーローション300mlで1,480円にゃ\n乾燥しやすい季節に、たっぷり使えるにゃ', reply: '容量はこちらで見られるにゃ' };
  const recentHooks = ['5と0のつく日に、598円のお米見つけたにゃ', '5と0のつく日中・3,680円'];
  assert.equal(checkPost(post, item, { factsText, saleName: '5と0のつく日', recentHooks }), null);
});

test('seasonalNg / pick：その月だけ夏物を外す', async () => {
  const { seasonalNg } = await import('../src/select.js');
  const rules = [{ months: [10, 11], pattern: '日やけ止め|虫よけ' }];
  assert.equal(seasonalNg(rules, new Date('2026-11-02T12:00:00+09:00')).length, 1);
  assert.equal(seasonalNg(rules, new Date('2026-07-02T12:00:00+09:00')).length, 0);
  const summer = normalize(raw({ itemCode: 's', itemName: 'ベビー 日やけ止め 虫よけ セット', endTime: '' }));
  const nov = new Date('2026-11-02T12:00:00+09:00');
  assert.equal(pick([summer], { posted: [], cfg: { ...cfg, seasonal_ng: rules }, repostAfterDays: 30, now: nov }), null);
  assert.equal(pick([summer], { posted: [], cfg, repostAfterDays: 30, now: nov }).itemCode, 's');
});

test('isBoostEve / eveLimit：5と0のつく日の前日だけ、最後の1本を22時台の予告に残す', async () => {
  const { isBoostEve, eveLimit } = await import('../src/post.js');
  const boost = { days: [5, 10, 15, 20, 25, 30], include_day_before: true };
  const at = (d) => new Date(`${d}T12:00:00+09:00`);
  assert.equal(isBoostEve(boost, at('2026-11-04')), true);
  assert.equal(isBoostEve(boost, at('2026-11-05')), false);
  assert.equal(isBoostEve(boost, at('2026-11-03')), false);
  const eve = { daily_limit: 5, reserve_hour: 22 };
  assert.deepEqual(eveLimit(eve, 3, 18), { limit: 5, skip: null });
  assert.match(eveLimit(eve, 4, 20).skip, /22時台の予告/);
  assert.deepEqual(eveLimit(eve, 4, 22), { limit: 5, skip: null });
  assert.deepEqual(eveLimit(null, 4, 20), { limit: null, skip: null });
});

test('つかみの型：直近の問いかけ型が半分より少なければ問いかけ型、多ければ場面型（2026-11-09 P02・P03）', () => {
  assert.equal(hookStyleFor([]), '問いかけ');
  // 記録した型（hook_style）で数える。1行目の「？」では数えない（2026-11-23 P03）
  assert.equal(hookStyleFor(['問いかけ', '問いかけ', '場面', '場面']), '場面');
  assert.equal(hookStyleFor(['問いかけ', '場面', '場面', '場面']), '問いかけ');
  assert.equal(hookStyleFor(['場面', '場面', undefined, null]), '問いかけ');
  const item = normalize(raw());
  const post = { parent: '洗剤の詰め替え6個セット見つけたにゃ\n重いしかさばるのに、玄関まで届く。\n2,980円で送料無料。', reply: 'まとめ買いにどうぞ' };
  assert.match(checkPost(post, item, { factsText: '6 2980', hookStyle: '問いかけ' }), /問いかけ型なのに/);
  assert.equal(checkPost(post, item, { factsText: '6 2980', hookStyle: '場面' }), null);
  assert.match(buildSystemPrompt(persona), /問いかけ型/);
  assert.match(buildSystemPrompt(persona), /場面型/);
});

import { retryOnMediaNotFound, publishParent, NoImageError } from '../src/threads.js';
test('公開で Media Not Found が返ったら、待って同じ形で作り直す（2026-11-09 P04）', async () => {
  const mnf = new Error('Threads API エラー (me/threads_publish): {"error_subcode":4279009,"error_user_title":"Media Not Found"}');
  const opts = { text: 't', token: 'x', wait: async () => {}, retryWaits: [0, 0] };
  let calls = 0;
  const flaky = async () => { calls++; if (calls === 1) throw mnf; return { id: '2', mediaCount: 3 }; };
  assert.deepEqual(await retryOnMediaNotFound(flaky, { ...opts, find: async () => null }), { id: '2', mediaCount: 3 });
  assert.equal(calls, 2);
  calls = 0;
  const done = await retryOnMediaNotFound(flaky, { ...opts, find: async () => ({ id: '1', permalink: 'p' }) });
  assert.equal(done.id, '1');
  assert.equal(calls, 1);
  await assert.rejects(retryOnMediaNotFound(async () => { throw new Error('別のエラー'); }, opts), /別のエラー/);
});

test('Media Not Found は最大2回作り直し、画像が付かなければ商品紹介は投稿しない（2026-11-16 P01）', async () => {
  const mnf = new Error('Threads API エラー (me/threads_publish): {"error_subcode":4279009,"error_user_title":"Media Not Found"}');
  let calls = 0;
  const twice = async () => { calls++; if (calls <= 2) throw mnf; return { id: '3' }; };
  const opts = { text: 't', token: 'x', wait: async () => {}, retryWaits: [0, 0], find: async () => null };
  assert.equal((await retryOnMediaNotFound(twice, opts)).id, '3');
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(retryOnMediaNotFound(async () => { calls++; throw mnf; }, opts), /Media Not Found/);
  assert.equal(calls, 3);

  // 画像の公開がずっと Media Not Found → textOnly: false なら NoImageError（テキストだけでは投稿しない）
  const realFetch = globalThis.fetch;
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  const posted = [];
  globalThis.fetch = async (url, o) => {
    const u = String(url);
    if (u.includes('/threads_publish')) return { ok: false, status: 400, json: async () => ({ error: { code: 24, error_subcode: 4279009, error_user_title: 'Media Not Found', is_transient: false } }) };
    if (u.includes('/me/threads') && o?.method === 'POST') { posted.push(String(o.body)); return ok({ id: 'C1' }); }
    if (u.includes('/me/threads')) return ok({ data: [] });
    if (u.includes('fields=status')) return ok({ status: 'FINISHED' });
    return ok({});
  };
  try {
    await assert.rejects(
      publishParent({ text: '本文', imageUrls: ['https://x/a.jpg'], token: 't', textOnly: false }, { wait: async () => {}, retryWaits: [0, 0] }),
      NoImageError,
    );
    assert.ok(posted.every((b) => !b.includes('media_type=TEXT')));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('場面型の1行目に「？」があれば不合格（2026-11-23 P03）', () => {
  const item = normalize(raw());
  const post = { parent: '洗剤の詰め替え、重くて持ち帰るのがつらくない？\n6個セットで2,980円\n玄関まで届くのは助かる', reply: 'まとめ買いにどうぞ' };
  assert.match(checkPost(post, item, { factsText: '6 2980', hookStyle: '場面' }), /場面型なのに/);
  assert.equal(checkPost(post, item, { factsText: '6 2980', hookStyle: '問いかけ' }), null);
});
