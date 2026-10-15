# Cloud Run でのオンライン大会

回答者はスマホの携帯回線などから早押しボタンを利用する。問題音声と投影は出題者画面だけで行い、口頭回答・主催者による判定はローカル版と同じ。1大会・回答者20人まで。AI参加者（Jev + LLM合議）も利用できる。

## 構成と起動入口

- ローカル版: 従来どおり `uvicorn app.main:app`。既存 PoC からの API 利用も変更しない。
- クラウド版: `uvicorn app.cloud.app:from_environment --factory --host 0.0.0.0 --port 8080 --workers 1`。
- `web` のみをビルド・配信する。PoC は package.json だけを依存解決に使い、ソースは送信・ビルド・配信しない。
- Firestore の名前付きデータベースに大会状態、非公開 Cloud Storage に問題 ZIP を保存する。ブラウザから Firestore やバケットへ直接アクセスしない。
- Cloud Run と Firestore は同じリージョンに置く。最大1インスタンス、1ワーカー、同時リクエスト80、タイムアウト3600秒、最小0インスタンスを初期設定とする。

## 必須設定

| 変数 | 内容 |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | GCPプロジェクトID |
| `QUIZ_DATABASE` | Firestoreデータベース名。省略時 `(default)` |
| `QUIZ_COLLECTION` | 保存コレクション。省略時 `quiz` |
| `QUIZ_BUCKET` | 問題ZIPの非公開バケット名 |
| `QUIZ_PUBLIC_URL` | 公開HTTPSオリジン。パス・クエリなし |
| `QUIZ_HOST_PASSWORD` | Secret Manager経由の主催者パスワード |
| `QUIZ_SESSION_SECRET` | Secret Manager経由の32文字以上の署名鍵。リビジョン間で共通にする |
| `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` / `XAI_API_KEY` / `TYPESAFE_API_KEY` | AI用キー。Secret Manager経由。未設定の機能は縮退する |

`JEV_MODEL`、`AI_READING_ENDED_DELAY_MS`、`QUIZ_CHAR_INTERVAL_MS` など既存設定も使用できる。署名鍵を変更すると既存の主催者セッションは無効になる。

## 開催する

1. トップページまたは `/host` を開く。
2. パスワード、開催時間（未指定24時間、0時間超〜168時間）、問題ZIPを入力し「認証して開始・復帰」。
3. 検証・保存が成功した時刻から開催時間を数える。検証失敗時は開催しない。開催中はパスワードだけで復帰できる。
4. 出題者画面のQR／参加URLを回答者へ案内する。URLを知る人が参加できるため、参加者にだけ共有する。
5. 「大会設定」で終了日時を確認できる。「大会を終了…」の後に確定操作を行うと終了する。

主催者認証は Secure・HttpOnly・SameSite=Strict Cookie。変更操作は公開オリジンと `X-Quiz-Request: 1` を検証する。WebSocketにもOrigin確認を行う。認証試行は接続元ごとに5分で5回まで。Cloud Runのプロキシ構成によっては同じ接続元として制限されるため、主催者が短時間に繰り返し再認証しない。任意の `X-Forwarded-For` は信用しない。

参加者の再接続トークンは大会ID別にブラウザへ保存する。終了した大会のURL・トークン・主催者セッションで次回大会へ入ることはできない。

## 問題ZIP

ルート直下に `questions.csv` を置く。CSV形式は [quiz-data.md](quiz-data.md) と同じ。

```text
questions.csv
20260820/
  0-20260820.wav
  0-20260820.txt
  0-20260820.lab
```

- ZIPは24 MiB以下、展開後192 MiB以下、4096エントリ以下、1ファイルの圧縮率200倍以下、問題2000問以下。
- `batch` は英数字・`-`・`_` の1〜64文字。ZIP内の絶対パス・`..`・シンボリックリンク・暗号化・重複パスは禁止。
- 音声3点セットが全部なければ文字表示のみ。一部欠損・CSVとの不一致はエラー。
- ZIPは認証後にアプリへ送信する。Cloud Runのリクエスト容量に収まる上限として24 MiBを採用し、大容量の直接アップロードは初期実装に含めない。
- 一時展開先はリクエスト終了／失敗時に清掃する。配信用キャッシュは大会終了またはプロセス終了時に清掃する。
- 手動終了ではZIPオブジェクトを削除する。期限切れ・未確定アップロード・削除失敗・スケール0中の清掃はバケットのライフサイクルで回収する。推奨設定は作成8日後に削除し、ソフト削除の復元猶予7日を維持する。終了済みデータは削除待ちでも配信しない。
- Firestoreの `current` ドキュメントは次回開始時に置換され、前回の参加者情報は引き継がない。`auth-*` は認証試行のハッシュ化された接続元と回数・期限を保持する。

## 保存・復元と早押し

各変更は最新ドキュメントをFirestoreトランザクションで読み、Roomへ適用して保存した後に配信する。保存失敗時は成功扱いにせず、接続を閉じて再接続を促す。同一受付プロセス内の操作はFIFOのロックで順序を保つ。複数プロセスの全体到着順や端末の申告時刻による補正は保証しない。異なる回線の遅延差は残る。

Firestore更新監視で別プロセスの確定状態も配信し、バージョンで古い配信を防ぐ。最大インスタンス設定だけで排他を保証しない。2秒ごとの生存確認と15秒のリースで実行主体の引継ぎを検出する。

引継ぎ時には開催期限、参加者、残りの出題順、現在の問題、確定済み回答権・判定・AI回答を保持する。進行中の問題は停止して復元し、主催者が「復元した大会を再開する」を押す。再起動前の音声位置は保存しないため、読み上げ中だった場合は先頭から再生する。確定済み回答権がある場合はその判定から続ける。

処理中のAIリクエストは自動再送しない。早押し時の読み上げ済み文が保存されていれば「AI回答を再実行」を主催者が押せる。文の保存前に障害が起きた場合は再実行できないため、主催者がチェック・判定して次問へ進む。ラウンド番号を更新し、再起動前の遅れたAI応答を拒否する。

WebSocketの60分タイムアウトによる通常再接続では同一参加者として復帰する。大会期限は延長しない。期限到達・手動終了で接続を閉じ、終了応答を受けた画面は再接続を止める。期限確認はタイマーだけでなく各接続・各操作でも行う。

## インフラとデプロイ

`deploy/cloud-run.yaml` は今回の検証環境の設定例。別環境ではプロジェクト・SA・バケット・公開URL・イメージを変更し、Secretのバージョンを固定する。

| リソース | 値 |
| --- | --- |
| プロジェクト | `${GCP_PROJECT}` |
| リージョン | `asia-northeast1` |
| サービス / Firestore DB | `trans-ai-quiz` |
| バケット | `${QUIZ_BUCKET}` |
| 実行SA | `${RUN_SERVICE_ACCOUNT}` |

実行SAへ付与する権限:

- `roles/datastore.user`: `resource.name == "projects/PROJECT/databases/trans-ai-quiz"` のIAM条件でDBを限定する。
- `roles/storage.objectUser`: 専用バケットのみ。Uniform bucket-level accessとPublic access preventionを有効にする。
- `roles/secretmanager.secretAccessor`: 使用するSecretごと。プロジェクト全体への付与は避ける。
- Cloud Runの呼出しは公開し、主催者・参加者の権限はアプリが確認する。Firestore Security Rulesでクライアント向け公開を許可しない。

Cloud Buildへ送るファイルは `.gcloudignore`、コンテナのビルド対象は `.dockerignore` で限定する。送信前に `gcloud meta list-files-for-upload` で `.env`・問題データ・PoCソース・ローカル依存が含まれないことを確認する。

```bash
gcloud builds submit --project ${GCP_PROJECT} --region asia-northeast1 \
  --config deploy/cloudbuild.yaml \
  --substitutions=_IMAGE=asia-northeast1-docker.pkg.dev/${GCP_PROJECT}/cloud-run-source-deploy/trans-ai-quiz:TAG .
```

`deploy/cloud-run.yaml` のイメージを更新して `gcloud run services replace` で適用する。初回はサービスのHTTPS URLを確定後に `QUIZ_PUBLIC_URL` を合わせる。独自ドメインを使う場合も、開くオリジンと設定を一致させる。`/api/health` が200になることを確認する。コンテナは非rootで起動し、アクセスログは出さず、キー・Cookie・参加URLをアプリログに記録しない。

バケット保持設定:

```bash
gcloud storage buckets update gs://${QUIZ_BUCKET} \
  --lifecycle-file=deploy/storage-lifecycle.json --soft-delete-duration=7d
```

通常運用で大会中のデプロイは避ける。ロールバックは、前の互換性のあるリビジョンへトラフィックを100%戻す。保存形式が変わる更新では互換性を別途確認する。

```bash
gcloud run services update-traffic trans-ai-quiz --project ${GCP_PROJECT} \
  --region asia-northeast1 --to-revisions=PREVIOUS_REVISION=100
```

## 検証

```bash
cd server
uv sync --frozen
uv run pytest
cd ..
npm run test -w web
npm run build -w web
```

`test_cloud_load.py` はローカルTCPを使って実際に20本の参加者WebSocketを接続する。メモリ保存先での結果はFirestore性能の保証ではない。実環境では、異なる回線での接続、同時buzz、期限切れ、手動終了、再接続、リビジョン切替後の停止・再開、AI実行を確認する。

参考: [Cloud Run WebSockets](https://docs.cloud.google.com/run/docs/triggering/websockets)、[コンテナ実行契約](https://docs.cloud.google.com/run/docs/container-contract)、[Secret Manager連携](https://docs.cloud.google.com/run/docs/configuring/services/secrets)。

Cloud Runには末尾が `z` の予約パスがあるため、公開ヘルスチェックは `/api/health` を使う。`/healthz` はローカルで200でもGoogle側404になる場合がある。[既知の制約](https://docs.cloud.google.com/run/docs/known-issues)

公開環境の検証専用大会を作る場合:

```bash
server/.venv/bin/python server/scripts/verify_cloud_run.py \
  --url ${QUIZ_PUBLIC_URL} \
  --password-file /path/to/private/password.txt \
  --ai --restart-project ${GCP_PROJECT}
```

`--ai` は各社への実API呼出しを行う。`--restart-project` は指定プロジェクトの `trans-ai-quiz` を新リビジョンへ更新する。運用中の大会がある場合は中止し、検証専用大会だけを終了する。主催者パスワードや参加URLは表示しない。
