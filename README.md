# Threads セール情報 bot（4アカウント）

楽天市場のセール品を、Threads の4アカウントに自動で投稿する bot です。

| アカウント | テーマ | 設定と記録 |
|---|---|---|
| @sale_neko | 日用品・食品 | `accounts/neko/` |
| @sale_desk_neko | デスク周り・PC周辺 | `accounts/desk/` |
| @sale_gadget_neko | イヤホン・スピーカー・スマートウォッチ | `accounts/gadget/` |
| @sale_kaden_neko | 家電 | `accounts/kaden/` |

## 動き方
1. 外部タイマー（cron-job.org）が、アカウントごとに毎時決まった分に GitHub Actions の「Threads に投稿」を起動します（平日 7・12・18・20・22時台、休日 9・15・18・20・22時台。セール期間と5と0のつく日は10・21時台も）。
2. 楽天市場APIで担当ジャンルのセール品を探し、1つ選びます。
3. **親投稿**：商品画像（最大3枚）＋3行の本文（AI が作成）＋PR表記。
4. 20〜45秒後に**リプライ**：一言＋【PR】＋商品リンク。
5. 投稿を `accounts/<名前>/data/posted.json` に記録します。

## 人が書くデータ（GitHub の画面で編集）
- `accounts/<名前>/data/experiences.json`：実際に使った商品の体験メモ（体験レビュー型に使う）
- `accounts/desk/data/desk_photos.json`：デスク写真の公開URLと一言（質問型に使う）
- `accounts/<名前>/data/sale_calendar.json`：楽天以外のセールの予定（月初のセールカレンダーに使う）

## 試すとき
**Actions →「Threads に投稿」→ Run workflow** で `account` を選びます。`投稿せずに投稿文だけ確認する` にチェックを入れると、投稿せずに投稿文だけ表示します。

仕組みと守るルールの詳細は `CLAUDE.md` にあります。
