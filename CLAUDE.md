# Threads セール情報 bot（4アカウント・Claude 向け引き継ぎ書）

楽天市場のセール品を選び、Threads に「親投稿＋リンクのリプライ」で自動投稿する bot です。
**4アカウントを1つのリポジトリで動かしている**（2026-11 に、4つに分かれていたリポジトリ sale-neko-bot・desk-bot・audio-bot・kaden-bot をまとめた）。

人間向けの説明は `README.md`。ここには **Claude が作業するときに知っておくべきこと**を書きます。

## アカウント

| フォルダ（ACCOUNT） | Threads | テーマ | タイマー | アカウントごとの違い |
|---|---|---|---|---|
| `accounts/neko` | @sale_neko（セールねこ） | 日用品・食品・飲料・お菓子・美容衛生・ベビー | 毎時 :10 | 2026-11-09 からお酒を止めている。秋冬は夏物（`rakuten.seasonal_ng`）、医療機器を除外 |
| `accounts/desk` | @sale_desk_neko（セールデスクねこ） | デスク周り・PC周辺 | 毎時 :14 | 1日4本（セール日も4本）。5と0のつく日の前日だけ5本で22時台に予告（`posting.boost_eve`）。D型（質問）が有効 |
| `accounts/gadget` | @sale_gadget_neko（セールガジェットねこ） | イヤホン・スピーカー・スマートウォッチ | 毎時 :18 | |
| `accounts/kaden` | @sale_kaden_neko（セール家電ねこ） | キッチン家電・生活家電・季節空調（家事の時短） | 毎時 :22 | |

## 全体像

```
外部タイマー（cron-job.org。アカウントごとに毎時決まった分）
  └ GitHub Actions：post.yml（account を指定）
      └ src/post.js            ACCOUNT のフォルダ（accounts/<名前>/）の設定と記録を使う
          ├ src/account.js     アカウントのフォルダを決める
          ├ src/templates.js   投稿の型（A／B／C／D）を選ぶ
          ├ src/rakuten.js     楽天市場API（検索・ランキング・ジャンル）
          ├ src/select.js      候補の絞り込み・点数付け・ジャンルの順番
          ├ src/writer.js      親投稿の本文を Claude で作成＋ルール違反の自動チェック
          ├ src/compose.js     定型文（AIが使えないとき）・親投稿/リプライの組み立て
          └ src/threads.js     Threads API（親投稿→待機→リプライ、再試行）
```

- **プログラム（`src/`）は4アカウント共通。アカウントごとの違いは `accounts/<名前>/config.json` と `accounts/<名前>/data/` だけ**に書く（`persona`＝キャラ・テーマ・共感の例・定型文、`genres`＝ジャンル、`rakuten`＝価格帯やNGワード、`posting`＝上限など）。
- 投稿の記録は `accounts/<名前>/data/posted.json`（bot が自動で commit する）。
- `presets/` は新しいアカウント用の設定の下書き。
- ジャンルに `months`（日本時間の月の配列）を書くと、その月だけ使う（`select.js` の `inSeason`）。季節ものは1〜2か月早めから入れる。
- AI には投稿する日（`facts` の `今日`）を渡し、季節に合わない話題を書かないよう指示している。

### 投稿の型（Threads × 楽天アフィリエイトで伸びる形）
ユーザーが集めた運用ノウハウ（2026年10月）を取り入れている。変えるときはユーザーに確認する。
- **時間**：平日 7・12・18・20・22時台、休日 9・15・18・20・22時台（`accounts/<名前>/config.json` の `posting.slots`）。**20時台は一番見られる枠**なので、上位からランダムではなく**一番点数の高い商品**を選ぶ（`prime`）。
- **起動は外部タイマー（cron-job.org）**：GitHub の定期実行（schedule）は混雑で数時間遅れたり飛ばされたりした（2026年10月、深夜1〜4時に投稿された・朝昼の枠が実行されなかった）ので使わない。cron-job.org が毎時決まった分に GitHub API で `post.yml` を `workflow_dispatch`（`inputs: {account: "neko", dry_run: "false", trigger: "timer"}`）し、`post.js` が日本時間から枠を判断する（`slotForNow`）。同じ時間帯に2回投稿しない（`postedThisHour`）。タイマーの分は bot ごとにずらす（neko :10、desk :14、gadget :18、kaden :22）。タイマー用の GitHub トークン（Actions: Read and write、このリポジトリ）は cron-job.org 側に保存する。
- **本数**：1日5本（朝1・昼1・夕1・夜2）。セール期間と**5と0のつく日・その前日**（`campaign.boost_days`）は追加枠（10・21時台）で最大7本。
- **親投稿は3行以内、1行目は「つかみ」**（え、待って。／これって私だけ？ など）。1投稿1テーマ。**リプライにリンク先が気になる一言**＋【PR】。AIは「親投稿 / `---` / リプライの一言」の形で出力し、`checkPost` が行数・文字数・禁止表現・数字を検査する。
- **つかみは毎回ちがう出だしに**：直近8件の投稿のつかみ（`posted.json` の `hook`）を AI に渡し、出だし4文字が同じなら `checkPost` で不合格にして書き直させる。
- **つかみの禁止**：「【速報】」「知らないと損」「騙されないで」「本当は教えたくない」「断言します」など根拠のない強い言葉は使わない（ノウハウ集には載っているが、景品表示法・ステマ規制上のリスクがあるため）。
- **遅れた定期実行は投稿しない**：GitHub の定期実行（schedule）で起動した場合だけ、予定時刻から `posting.max_delay_minutes`（90分）より遅れていたら何もしない（今は schedule を使っていないので、予備の仕組み）。
- **画像は複数枚**：楽天APIの画像（最大3枚）をカルーセルで投稿し、滞在時間を延ばす。失敗したら1枚→テキストのみに切り替え。ただし公開で「Media Not Found」（Threads 側の一時的な不調）が返ったときは、切り替える前に30秒待って同じ形で作り直す（自分の最近の投稿に同じ本文があれば作り直さない。2026-11-09 P04）。
- **トピックタグ（#）は付けない**（`posting.use_topic_tag: false`。有名ブランドのときだけ true にする運用）。
- **報酬率**：検索は標準順と報酬率の高い順（`-affiliateRate`）の両方から候補を集め、10%以上を大きく優先する。
- **まだ入れていないもの**：「伸びた投稿を3日後に再投稿」は、いいね数などを取るのに `threads_manage_insights` 権限が要るので未対応。「有益投稿→アフィ投稿の順」も未対応（有益投稿は事実確認が必要なため）。
- **GitHub Actions の時間**：このリポジトリは**公開**にしているので、GitHub Actions は時間の上限なく無料で使える（2026-11-24 に公開。非公開のときはアカウント全体で月2,000分を4 bot で分け合っていて足りなくなった）。公開なので、Secrets 以外（プログラム・設定・投稿記録・実行記録）は誰でも見られる。鍵や個人情報をファイル・ログに書かない。

### 投稿の型（A／B／C／D。2026年10月末にユーザーの指示で追加）
`src/templates.js` の `chooseTemplate` が毎回1つ選ぶ。設定は `accounts/<名前>/config.json` の `templates`。
- **A：セール速報型**（ふだん）：1行目はつかみ（セール中はセール名を入れる）、2行目に商品と価格。1行目は「つかみの型」を交互に使う：**問いかけ型**（「？」で終える）と**場面型**（季節の体感・具体的な場面から入る）。直近8件のつかみのうち問いかけ型が半分より少なければ問いかけ型にする（`writer.js` の `hookStyleFor`、記録は `posted.json` の `hook_style`。2026-11-09 Muse の提案 P02・P03）。価格・ポイント倍率だけの1行目にはしない（数字は冒頭2行のどこかにあればよい）。本文の下に `🗓 セール名：開始〜終了` の行を機械的に付ける。リンクはリプライ。
- **B：実体験レビュー型**：`accounts/<名前>/data/experiences.json` に**人が書いた体験メモ**がある商品だけ（`every` 本に1回）。使った期間・良かった点・微妙だった点を AI がメモだけから書き、末尾に `💰 いまの価格` を付ける。**メモがない商品で体験談を作らない**（B型のときだけ「使ってみた」などの言葉を許す）。
- **C：まとめ型**：月初（`calendar_day`）の最初の枠で「📅 今月のセールカレンダー」（楽天の `campaign.periods` ＋ `accounts/<名前>/data/sale_calendar.json` に人が書いた Amazon などの予定。**日程を推測で書かない**）。月末の最初の枠で、今月紹介した商品を取り直して評価順に並べるまとめ（画像はカルーセル、リンクは1商品ずつリプライ）。**全部に体験メモがあるときだけ「買ってよかった」**、それ以外は「レビュー評価が高かった」。
- **D：質問型**：`accounts/desk/data/desk_photos.json` のデスク写真（公開URL）＋「あと何かいるかな？」（`every` 本に1回。デスク用で有効）。リンク・PRなし。冒頭2行に数字がなければログで注意する。
- **共通**：`checkPost` が「冒頭2行に数字」「最後が『安い』『お得』だけで終わらない」「A型はセール中なら1行目にセール名」を検査する。つかみの出だし比べはセール名を除いて行う。
- **割引率・値下げ前の価格は使わない**：楽天APIに値下げ前の価格がないため（有利誤認の防止）。数字は価格・ポイント倍率・期間など、データにあるものだけ。
- **効果測定**：`posted.json` に `template_type`・`template_kind`・`has_price`・`has_discount_rate`（％またはポイント倍率）・`number_in_head`・`sale_name`・`has_media` を記録。`report.yml`（手動）が型ごとのいいね・返信・リポスト・引用の平均を表にする（`threads_manage_insights` 権限が必要）。型のない古い投稿は「従来型」として分ける。
- 試すとき：`post.yml` の手動実行で `template` に `B` / `C-calendar` / `C-top` / `D` を入れる（`dry_run` と一緒に）。

### ワークフロー（`.github/workflows/`）
| ファイル | 役割 |
|---|---|
| `post.yml` | 投稿。`account`（neko / desk / gadget / kaden）を指定。外部タイマーから `trigger=timer` で起動される。手動実行で `dry_run`・`group`・`preset`・`template` を指定できる。アカウントごとに順番に動く（concurrency は `post-<account>`） |
| `refresh-token.yml` | 4アカウントの Threads トークンを毎月1日・15日に更新し、`GH_PAT` で Secret に保存し直す |
| `update-campaigns.yml` | 楽天の公式ページからお買い物マラソン・スーパーセールの期間を毎日取り込み、4アカウントの config.json に書く |
| `genres.yml` | 楽天のジャンルIDの一覧を表示する |
| `report.yml` | 4アカウントの、型ごとの反応（いいね・返信・リポスト・引用）とアカウント全体の数を集計する（`threads_manage_insights` 権限が必要） |

### Secrets（Settings → Secrets and variables → Actions）
| 名前 | 中身 |
|---|---|
| `RAKUTEN_APP_ID` / `RAKUTEN_ACCESS_KEY` / `RAKUTEN_AFFILIATE_ID` | 楽天（4アカウント共通） |
| `THREADS_ACCESS_TOKEN_NEKO` / `_DESK` / `_GADGET` / `_KADEN` | 各アカウントの Threads トークン（threads_basic・threads_content_publish・threads_manage_replies・threads_manage_insights） |
| `ANTHROPIC_API_KEY` | Claude の API キー（4アカウント共通。`ANTHROPIC_API_KEY_DESK` のようにアカウント別に置けばそちらを使う） |
| `GH_PAT` | トークン自動更新用（このリポジトリだけ・Secrets の Read and write） |

## 必ず守るルール（法律・規約）

ユーザーから「外したい」と言われても、外すとリスクがあるものは理由を説明してから判断してもらう。

- **ステマ規制（景品表示法）**：親投稿の末尾に `PR`、リプライの先頭に `【PR】` を必ず入れる。タイムラインに流れるのは親投稿だけなので、**親投稿の PR は絶対に外さない**。PR をハッシュタグの山に埋もれさせない。
- **体験談の捏造をしない**：bot は商品を使っていない。「使ってみた」「リピ買い」「愛用」などは禁止（`writer.js` の `BANNED`）。
- **データにない比較・割引を書かない**：「ドラッグストアより安い」「最安」「定期便で割引」「◯%OFF」などは、楽天APIのデータで確認できないので禁止（有利誤認）。
- **数字はデータにあるものだけ**：`checkText` が、本文の数字がすべて商品データ（商品名・価格・レビュー・セール終了日時・商品説明）にあるかを確かめる。ないものがあれば AI の文を捨てて定型文にする。
- **効果・効能をうたわない**（薬機法・健康増進法）：体にいい、痩せる、美白、育毛、睡眠の質が上がる など。NGワードは `rakuten.ng_name_pattern`（商品名で除外）と `persona.extra_banned`（本文で禁止）。
- **お酒**：グループに `notice`（20歳未満の飲酒禁止）を付け、親投稿とリプライの両方に表示する。**@sale_neko では 2026-11-09 からお酒のジャンルを止めている**（投稿がほぼ表示されない原因の候補：お酒など規制のある商品の販売を勧める投稿は Meta のおすすめ対象外。アカウントのステータスに処分はなかった）。飲料ジャンルにお酒・ノンアルが混ざらないよう `ng_name_pattern` にも入れた。2週間ほど様子を見て、戻すかは Muse の調査で判断する（戻すときは git の履歴から genres のお酒を戻す）。
- **自動投稿であることを隠さない**：プロフィールに自動投稿・PR を含むことを書いてもらう。投稿時刻のゆらぎ（jitter）は自然さのためで、bot であることを隠す目的ではない。
- **家電・ガジェット**：技適のない無線機器、PSE のない電源機器、中古・ジャンク品は `ng_name_pattern` で除外している。

## API の注意点（ハマったところ）

### 楽天市場API（2026年に仕様変更が多い）
- **`applicationId` と `accessKey` の両方が必須**。`affiliateId` を渡すと `affiliateUrl` が自分のIDで返る。
- **`Origin` ヘッダーが必須**。値はアプリ登録時の「許可されたWebサイト」と一致させる（このbotは `https://www.threads.com`）。ないと `403 REQUEST_CONTEXT_BODY_HTTP_REFERRER_MISSING`。
- アプリの種類を「サーバー」にすると**固定IPの登録が必要**になり、GitHub Actions（IPが毎回変わる）では使えない。**「Web」で登録する**。
- エンドポイントのバージョンが頻繁に変わる（`config.json` の `*_endpoint`）。エラーが出たら https://webservice.rakuten.co.jp/documentation の最新版を確認する。
- 1秒1回程度に抑える（`rakuten.js` で間隔を空け、429 は再試行）。**複数の bot で同じアプリIDを使うと上限を共有する**ので、投稿時刻（cron）をずらす。
- アプリIDには**1年の有効期限**がある（延長ボタンを押す）。

### Threads API
- 権限：`threads_basic`、`threads_content_publish`、**リプライには `threads_manage_replies`**。権限を追加したら**トークンを発行し直す**（古いトークンには新しい権限が付かない）。
- トークンは Meta for Developers の「ユースケース → カスタマイズ → 設定 → ユーザートークン生成ツール」で発行（約60日）。`refresh-token.yml` が自動更新する。
- 画像は公開URLから取り込まれる。楽天の画像は `_ex=600x600` で大きくして渡している。
- リンクは本文に書かず `link_attachment` でカード表示にしている。

### Claude API（親投稿の本文）
- `src/writer.js`。モデルは `claude-sonnet-5-5`（費用を抑えるためユーザーが選択。Opus 5.5 の約半額）、`effort: low`、拒否時の自動切り替え（`fallbacks: "default"`）あり。
- キーは**専用ワークスペースに限定したキー**を使う（「組織」スコープは Admin API まで触れるので使わない）。
- キーがない・失敗した・チェックに落ちたときは定型文（`persona.template`）で投稿が続く。

### このクラウド環境（Claude Code on the web）から操作するとき
- `gh` の GraphQL は使えない。`gh api repos/...`（REST）を使う。例：手動実行は `gh api -X POST repos/takatoshihirokawa/threads-bots/actions/workflows/post.yml/dispatches -f ref=main -f 'inputs[account]=neko' -f 'inputs[dry_run]=true'`、ログは `gh run view RUN_ID -R OWNER/REPO --log`。
- Secrets の一覧・値はこの環境から読めない（読めなくてよい）。ユーザーに GitHub の画面で登録してもらう。
- 新しいリポジトリは、ユーザーが Claude GitHub App のアクセス許可に追加するまで見えない。

## 新しいアカウントを足す手順

ユーザーは Studio / Bubble を使うノーコード開発者。手順は1つずつ、リンク付きで案内する。

1. **設定**：`presets/<テーマ>.json` を `accounts/<新しい名前>/config.json` にコピーし、`persona.account_name`・`persona.voice`・`account.threads_username` を書く。`accounts/<新しい名前>/data/` に `posted.json`・`experiences.json`・`desk_photos.json`・`sale_calendar.json`（中身は `[]`）を作る。ワークフローの `options` と `matrix.account` に名前を足す。
2. **Threads アカウント**：Instagram アカウントを新規作成。プロフィール画像・自己紹介文（自動投稿であること・PR を含むことを明記）を一緒に作る。
3. **Meta**：Meta for Developers でアカウント専用のアプリを作る（権限は上の4つ）→ Threads テスターに追加・承認 → **ブラウザの Threads をそのアカウントでログインしてから**トークン発行。
4. **Secrets**：`THREADS_ACCESS_TOKEN_<名前の大文字>` を登録する。
5. **タイマー**：cron-job.org に、ほかのアカウントと重ならない分でタイマーを足す（楽天APIの上限を共有するため）。
6. **確認**：`dry_run` で投稿文を見てもらう → 見え方を確認してから `paused: false`。

## 開発のしかた
- テスト：`npm test`（`node --test`。API は呼ばない）。ローカルで動かすときは `ACCOUNT=neko DRY_RUN=1 node src/post.js`。
- 変更したら `npm test` → commit → `main` に push（main が本番）。投稿に関わる変更は push 後に `dry_run` で確認する。
- **`dry_run` を流す時間**：各アカウントのタイマー（毎時 :10〜:25）とかぶらない :30〜:05 に流す。同じアカウントの本番の実行が待っているときに流すと、取り消されることがある（`post.yml` の concurrency）。
- **週次改善サイクル**：Muse（調査エージェント）の改善案を毎週月曜に反映している。手順と置き場所は `threads-research` リポジトリの `CLAUDE.md`・`CONTEXT.md`。
- 文章（ログ・コメント・README）は日本語。ユーザー向けの説明は専門用語を避け、手順にはリンクを付ける。

## 外部メモリ（Notion「AI共通メモリ」）

AIとやった作業の最終結果は、Notionの「AI共通メモリ」＞「作業ログ」に積み上げている。記録と読み返しの手順はスキル `notion-memory`。スキルが使えないときは、Notionのページ「AI共通メモリ」（https://www.notion.so/40fe4e613e19816aa099c8ae73cdb880 ）に書かれたルールに従う。

- **作業を始める前**：作業ログを「リポジトリ」欄 = `threads-bots` で絞り込み、過去の「決定」と「課題」を確認する。
- **PRを作った直後**：言われなくても作業ログに1件記録する（「リポジトリ」欄は `threads-bots`、「記録したAI」は `Claude Code`）。
- **それ以外**：「Notionに残して」と言われたときに記録する。途中経過は記録しない。
- **記録の要約**：この作業でAIが何度もやり直した点・ユーザーに指摘された点があれば、要約に1行入れる（毎週金曜の「週次ふりかえり」で、ルール改善の材料にする）。

## 作る前に完成条件を決める

実装・変更を始める前に、次の2点を2〜3行で書き、ユーザーに確認してから作り始める（誤字直しなどの小さな修正は不要）。

- **完成条件**：何ができたら完成か
- **確認方法**：どう確かめるか（例：この画面でこう操作するとこう表示される／このコマンドが通る）

作業の最後に、確認方法を実際に試した結果を報告する。試せなかったものは「未確認」とはっきり書く。

※ 定期実行（ルーティン）など人が見ていない作業や、「確認せずに進めてよい」と指示された作業では、ユーザーへの確認は待たない。完成条件と確認方法を自分で書いてから進め、最後に結果を報告する。
