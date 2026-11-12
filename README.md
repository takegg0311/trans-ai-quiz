# AI横断クイズ (trans-ai-quiz)

Cloud Run での公開開催（主催者認証・問題ZIP・開催期限・再起動復元）は [docs/cloud-run.md](docs/cloud-run.md) を参照。ローカル起動の手順は従来どおり。

![image](docs/cover.png)

早押しクイズの問題文を各社 LLM へ送り、続きの補完と答えを比較する。
現在の実験の主対象は [`llm-poc`](docs/llm.md) と [`jev-poc`](docs/jev-poc.md) である。

同一ネットワーク内で開催するオンライン早押し（投影 + スマホ）も持つ。
物理ボタン参加は別リポジトリ [trans-ai-quiz-buzzer](https://github.com/takegg0311/trans-ai-quiz-buzzer) の Raspberry Pi 中継器で対応する（スマホ回答者と同じ WebSocket・早押し判定は本リポジトリのサーバのまま）。
**AI を参加者として加えられる**（判定 API が早押しし、3 モデルの合議で回答する）。
元になった 1 台完結の PoC（[`poc/`](docs/poc.md)）は凍結している。

## 構成

フロントは 4 つ（`llm-poc/`・`jev-poc/`・オンライン版・凍結 `poc/`）。
`server/` は LLM 中継・早押し判定・オンライン版のルーム判定を担う共通バックエンドである。

出題データとジングル SE はリポジトリルートに置き、オンライン版・`jev-poc`・凍結 `poc/` で共有している。
`llm-poc` は問題データを使わない。


| ディレクトリ     | 内容                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------- |
| `llm-poc/` | LLM 予測比較の PoC。[詳細](docs/llm.md)                                                                      |
| `jev-poc/` | 3 社の早押し判定を並べて比べる PoC。[詳細](docs/jev-poc.md)                                           |
| `web/`     | オンライン版のフロントエンド。出題者用（投影）と回答者用（スマホ）。AI 参加者も持つ。[詳細](docs/online.md)                                     |
| `poc/`     | **凍結**。音声読み上げによる早押しの PoC。[詳細](docs/poc.md)                                                           |
| `server/`  | バックエンド（Python / FastAPI）。[LLM 中継](docs/llm.md)・[早押し判定](docs/jev-poc.md)・[オンライン版の判定](docs/online.md) |
| `docs/`    | 詳細ドキュメント                                                                                             |


```
trans-ai-quiz/
├── docs/          詳細ドキュメント
├── quiz_data/     問題データ（CSV と VOICEPEAK の出力）
├── sound/         ジングル SE
├── server/        バックエンド（オンライン版の判定・LLM 中継・早押し判定）
├── web/           オンライン版フロントエンド
├── llm-poc/       LLM 予測比較 PoC
├── jev-poc/       3 社の早押し判定を並べて比べる PoC
└── poc/           音声早押し PoC（凍結）
```

## 必要なもの

- Node.js 20 以上
- オンライン版・`llm-poc`・`jev-poc` を動かす場合は、追加で Python 3.12 以上と [uv](https://docs.astral.sh/uv/)
- LLM 予測を使う場合は、各社の API キー
- 早押し判定を使う場合は、使う provider の API キー（TypeSafe / OpenAI / Gemini）
- 音声読み上げをする場合は、 VOICEPEAK からの出力が必要

## セットアップ

```bash
npm install
```

npm workspaces 構成のため、リポジトリルートで実行する。

## クイズ問題 - `quiz_data/`

オンライン版・`jev-poc`・凍結 `poc/` では、クイズ問題 `quiz_data/questions.csv` が最低 1 問必要（`llm-poc` は不要）。
無い場合もサーバは起動するが、オンライン版の `/host` `/player` `/ws` は 503 になる。

```bash
cp quiz_data/questions_example.csv quiz_data/questions.csv
```

さらに、VOICEPEAKからデータ（`.wav` / `.txt` / `.lab`）を出力することで、音声読み上げを行い、音声に同期して問題文を表示することが出来る。

VOICEPEAKデータが無い場合も、`quiz_data/questions.csv` に行を足すだけで出題できる（読み上げなし・1 文字ずつ等速の文字送りになる）。

問題データの形式は [docs/quiz-data.md](docs/quiz-data.md)。

## ジングル SE - `sound/`

問題の読み上げ音声とは別に、早押しのフィードバックとして鳴らすことが出来る。ジングルSEは無くても動作する。


| ファイル名         | 再生タイミング               |
| ------------- | --------------------- |
| `set.WAV`     | 出題時（この再生完了後に問題音声が始まる） |
| `buzz.WAV`    | 早押し時                  |
| `correct.WAV` | 正解時                   |
| `wrong.WAV`   | 不正解時                  |

## オンライン版、LLM・判定サーバー - `server/`

![image](docs/online-mode.png)

`llm-poc`・凍結 `poc` の LLM 中継、`jev-poc` / オンライン版の早押し判定、およびオンライン版のルーム判定を行う。

```bash
cp server/.env.example server/.env
# オンラインクイズを行う場合のみ、フロントをビルドする
npm run build -w web
```

```bash
cd server
uv sync
# オンラインクイズを行わない場合
uv run uvicorn app.main:app --port 8000
# オンラインクイズを行う場合
uv run uvicorn app.main:app --host 0.0.0.0 --port 8000
```

起動すると、出題者用 URL（トークン付き）と参加者用 URL が表示される。

> [!IMPORTANT]
> `--host 0.0.0.0` を省くと `127.0.0.1` に bind され、**参加者のスマホから繋がらない**。
> 繋がらないときの切り分けは [docs/online.md](docs/online.md#参加者のスマホから繋がらないとき)。

AI に早押しボタンを押させる場合は、`server/.env` に `JUDGE_PROVIDER`（空なら typesafe）と対応する API キー、および回答用の各社キーを設定する。
出題者画面の「AI 参加者」で参加を切り替える。

`--workers` は増やさないこと。ルームの状態はプロセス内のメモリに持つ。

オンライン早押しクイズの開催手順・開発時の起動は [docs/online.md](docs/online.md)。

## LLM 予測比較 - `llm-poc/`

![image](docs/llm-poc.png)

早押しクイズの問題文を手入力し、各社 LLM へ送信、答えを比較する。

`server/.env` に使うプロバイダのキーを設定する。


| 環境変数                | 用途            |
| ------------------- | ------------- |
| `OPENAI_API_KEY`    | OpenAI        |
| `ANTHROPIC_API_KEY` | Claude        |
| `GEMINI_API_KEY`    | Google Gemini |
| `XAI_API_KEY`       | xAI Grok      |


`server` を起動した上で、別のターミナルでフロントを起動する。

```bash
npm run dev -w llm-poc
```

操作・記録・プロンプトは [docs/llm.md](docs/llm.md)。

## 早押し判定の比較 - `jev-poc/`

![image](docs/jev-poc.png)

同じ問題を TypeSafe / OpenAI / Gemini の 3 社に並列で投げ、押しポイントと応答の遅れを並べて比べる。

`server/.env` に使う provider のキーを設定して `server/` を起動しておく。キーが無い枠は OFF に固定される。

```bash
npm run dev -w jev-poc
```

操作と API は [docs/jev-poc.md](docs/jev-poc.md)。
