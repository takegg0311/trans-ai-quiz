# LLM 予測

`server/` が各社 API を中継する。
主クライアントは [`llm-poc`](#llm-poc)（予測と記録）。
凍結 [`poc/`](poc.md) も同じ `/api/llm/predict` を使うが、早押し画面の付随機能である。

[`jev-poc`](jev-poc.md) は**両方**を使う。早押しの判定は Jev（`/api/jev/*`）、
AI が押した後の回答は `/api/llm/predict`（3 モデルの合議）である。

判定に Jev を使うのは、`/predict` が補完タスクであり、どんな短い断片でも問題文を
繋げようとするため、「今が確定ポイントか」の判断には使えないことによる。

現在は **OpenAI / Claude / Gemini / xAI Grok に対応**。

## 仕組み

API キーはブラウザのバンドルに埋め込めず、各社 API にはブラウザからの直接呼び出しに CORS 制限があるため、`server/` が中継する。

```
llm-poc (vite) ──/api/llm/* をプロキシ──▶ server (:8000) ──▶ 各社 API
poc     (vite) ──/api/llm/* をプロキシ──▶

jev-poc (vite) ──/api/llm/* をプロキシ──▶
               └─/api/jev/* をプロキシ──▶ server (:8000) ──▶ TypeSafe（別系統）
```

| 経路 | 使うクライアント | 内容 |
| --- | --- | --- |
| `/api/llm/predict` | `llm-poc`・`jev-poc`・凍結 `poc/` | 問題文の断片から続きと答えを予測する。正解は受け取らない |
| `/api/llm/log` | `llm-poc` のみ | 正解と正誤を受け取り、CSV へ記録する |
| `/api/llm/health` | 両方 | 利用可能なプロバイダとモデルを返す |

`/predict` に正解を載せないのは、凍結 PoC では早押し時点で正解をサーバへ渡したくないため。
`llm-poc` は画面の流れが「送信 → 応答を待つ → 正解を入力」なので、正誤は `/log` で後から送る。

xAI Grok は OpenAI 互換の API を提供しているため、専用の SDK は入れず、OpenAI SDK の接続先（`base_url`）を `https://api.x.ai/v1` へ差し替えて使う。

この機能は出題データに依存しない。
`questions.csv` の検証に失敗してもサーバは起動し、`/api/llm/*` は使える。
ただし **オンライン版の入口（`/host` `/player` `/ws`）は 503 で閉じる**。

## セットアップ

```bash
cp server/.env.example server/.env
```

`server/.env` に使うプロバイダのキーを設定する。
キーが未設定のプロバイダは利用不可として扱われ、クライアントの選択肢に現れない。

| 環境変数 | 用途 |
| --- | --- |
| `OPENAI_API_KEY` | OpenAI |
| `ANTHROPIC_API_KEY` | Claude |
| `GEMINI_API_KEY` | Google Gemini |
| `XAI_API_KEY` | xAI Grok |
| `LLM_PLAIN_ANSWER_MAX_LENGTH` | 読み切り時に平文の答えを許容する最大文字数（既定 30） |

```bash
cd server && uv run uvicorn app.main:app --port 8000
```

疎通確認:

```bash
curl http://localhost:8000/api/llm/health
```

## llm-poc

早押しクイズの問題文を各社 LLM へ同じプロンプトで送り、答えを並べて比較する。
結果は CSV へ記録され、後からモデル間の傾向を振り返れる。

出題サイクルを持たない。問題文はテキストで直接入力する。
server が起動している必要がある（中継と記録の両方を担うため）。未起動なら何もできない。

```bash
npm run dev -w llm-poc
```

### 使い方

1. **問題文を入力する。** 途中で切れていて構わない
2. **「途中まで」/「読み切り」を選ぶ**
   - 途中まで: 問題文の続きを補完した上で、答えを予測させる
   - 読み切り: 答えのみを予測させる
3. **「送信」** で、選択中の枠すべてへ並列に送る
4. **正解を入力する。** 各枠に ○ / × が出る
5. 表記揺れや別解で × になった枠は、**「正解にする」** で手動で拾う
6. **「この問題を確定」** で CSV へ記録する
7. **「次の問題へ」** で入力を空にする

枠のプロバイダとモデルは、枠ごとに選べる（最大 4 枠）。選択は localStorage に残る。

### 正誤判定

**正規化した上での完全一致**とする。全角半角・大文字小文字・空白・記号の揺れは吸収するが、部分一致は取らない。

部分一致を許すと、正解語を含むだけの誤答（正解「富士山」に対する「富士山ではありません」など）が自動的に正解と判定され、手動正解ボタンの意味が薄れるため。
別解や表記揺れは人が拾う前提にしている。

### 記録

`llm-poc/logs/predictions.csv` へ追記される（`.gitignore` 対象）。
**1 送信 × 1 LLM = 1 レコード**。

| 列 | 内容 |
| --- | --- |
| `timestamp` | 確定した時刻。同じ送信の行は同じ値になる |
| `question_text` | 送信した問題文 |
| `complete` | 読み切りなら `true` |
| `expected_answer` | 入力した正解 |
| `vendor` / `model` | プロバイダとモデル |
| `answer` | LLM が返した答え |
| `continuation` | 補完された問題文全文（読み切り時は空） |
| `elapsed_ms` | 応答時間 |
| `ok` | 予測が成功したか（違反・エラーなら `false`） |
| `error_kind` | 失敗の種別 |
| `correct` | 最終的な正誤 |
| `manual` | 手動正解ボタンで拾ったか |

`correct` と `manual` を分けているのは、自動判定だけの集計も後から行えるようにするため。

記録先は `LLM_POC_LOG_PATH` で差し替えられる。

## 凍結 PoC 側の挙動

凍結 `poc/` は起動時に `/api/llm/health` を 1 回だけ叩き、疎通しなければ予測枠を縮退させる（早押しと回答は従来どおり動く）。
後から server を起動した場合は、画面の「再チェック」で拾い直せる。

**予測の正誤は、人間が回答するまで表示されない。**
先に ○/× が出ると、それを見て答えられてしまうため。

LLM へ渡すのは早押し時点で画面に出ていた文字列だけである。

## 応答フォーマット

JSON で返すようプロンプトで指示する。OpenAI の `response_format` などによる JSON 強制は**使わない**。
指示に従うかどうかの観測もこの機能の目的であり、強制すると違反が発生しなくなるため。

早押しで止めた場合（続きの予測あり）:

```json
{ "continuation": "<補完した問題文の全文>", "answer": "<答え>" }
```

読み切った場合（続きの予測なし）:

```json
{ "answer": "<答え>" }
```

読み切り時に限り、短い平文の応答もそのまま答えとして扱う（既定 30 文字まで）。
これを超える平文や、JSON として解釈できない応答は**応答フォーマット違反**とする。
違反はエラーではなく、モデルが指示に従わなかったという観測結果として扱う。

## プロンプト

`partial_text` が早押しクイズの問題文であることを必ず伝える。
これを省くと「日本で一番高い山は富士山です」から「富士山は静岡県と山梨県の県境にあり…」のような説明文が補完され、問いの形にならず答えを出せない。

「〜ですが、」で前半を振ってから後半で別を問う形式（パラレル問題）が頻出するため、前半の語がそのまま答えとは限らないことも指示に含めている。

プロンプトはプロバイダ間で共通のものを使い、社ごとの最適化はしない。
社ごとに変えると予測精度の比較が公平でなくなるため。

## ファイル構成

```
server/app/llm/
├── config.py            .env の読み込みと閾値
├── prompt.py            プロンプト生成（早押し用 / 読み切り用）
├── parser.py            応答の解釈と違反判定
├── base.py              プロバイダの共通契約とエラー正規化
├── registry.py          プロバイダ一覧
├── openai_provider.py   OpenAI
├── anthropic_provider.py Claude
├── gemini_provider.py   Google Gemini
├── xai_provider.py      xAI Grok（OpenAI 互換）
├── router.py            /api/llm/health, /api/llm/predict, /api/llm/log
└── log.py               llm-poc の予測結果を CSV へ追記する
```

```
llm-poc/
├── index.html
├── vite.config.ts             /api/llm を server へプロキシ
└── src/
    ├── App.tsx                入力・予測・記録の流れ
    ├── lib/
    │   ├── llm.ts             予測 API の呼び出し
    │   ├── llmSlots.ts        枠の選択状態（localStorage）
    │   ├── useLlmPrediction.ts 予測と手動正解の状態管理
    │   ├── answer.ts          正誤判定（完全一致）
    │   └── log.ts             記録 API の呼び出し
    └── components/            画面パーツ
```

```
poc/src/
├── lib/
│   ├── llm.ts               health / predict の呼び出し
│   ├── llmSlots.ts          枠の選択と localStorage への保存
│   └── useLlmPrediction.ts  疎通確認・並列送信・結果の保持
└── components/
    ├── LlmPanel.tsx         4 枠のまとめと縮退表示
    ├── LlmSlot.tsx          枠 1 つ分の選択と結果
    └── RawResponseModal.tsx 生の応答を見せるモーダル
```
