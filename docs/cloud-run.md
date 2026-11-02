# Cloud Run でのオンライン大会

回答者はスマホの携帯回線などから早押しボタンを利用する。問題音声と投影は出題者画面だけで行い、口頭回答・主催者による判定はローカル版と同じ。1大会・回答者20人まで。AI参加者（Jev + LLM合議）も利用できる。

## 構成と起動入口

- ローカル版: 従来どおり `uvicorn app.main:app`。既存 PoC からの API 利用も変更しない。
- クラウド版: `uvicorn app.cloud.app:from_environment --factory --host 0.0.0.0 --port 8080 --workers 1`。
- `web` のみをビルド・配信する。PoC は package.json だけを依存解決に使い、ソースは送信・ビルド・配信しない。
- Firestore の名前付きデータベースに大会状態、非公開 Cloud Storage に問題 ZIP を保存する。ブラウザから Firestore やバケットへ直接アクセスしない。
- Cloud Run と Firestore は同じリージョンに置く。最大1インスタンス、1ワーカー、同時リクエスト80、タイムアウト3600秒、最小0インスタンスを初期設定とする。
- ジングル SE はリポジトリルートの `sound/`（`set.WAV` / `buzz.WAV` / `correct.WAV` / `wrong.WAV`）をコンテナに同梱し、出題者画面だけが `/sound` 経由で再生する。`.gcloudignore` と `.dockerignore` で `sound/` を送信・COPY 対象に含めるため、Git 未追跡でも手元に置いた WAV は Cloud Build に載る。未配置でもアプリは動くが、SE は鳴らない。イメージは非 root ユーザーで動くため、Dockerfile で `sound/` を world-readable にしている（手元が `chmod 700` でもビルド後に読める）。

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

Firestore更新監視で別プロセスの確定状態も配信し、バージョンで古い配信を防ぐ。最大インスタンス設定だけで排他を保証しない。2秒ごとの生存確認と15秒のリースで実行主体の引継ぎを検出する。また、主催者が別プロセスに接続した際も引き継いで停止する。旧リビジョンが生存し続けても、主催者の復帰を妨げないため。

引継ぎ時には開催期限、参加者、残りの出題順、現在の問題、確定済み回答権・判定・AI回答を保持する。進行中の問題は停止して復元し、主催者が「復元した大会を再開する」を押す。再起動前の音声位置は保存しないため、読み上げ中だった場合は先頭から再生する。確定済み回答権がある場合はその判定から続ける。

処理中のAIリクエストは自動再送しない。早押し時の読み上げ済み文が保存されていれば「AI回答を再実行」を主催者が押せる。文の保存前に障害が起きた場合は再実行できないため、主催者がチェック・判定して次問へ進む。ラウンド番号を更新し、再起動前の遅れたAI応答を拒否する。

WebSocketの60分タイムアウトによる通常再接続では同一参加者として復帰する。大会期限は延長しない。期限到達・手動終了で接続を閉じ、終了応答を受けた画面は再接続を止める。期限確認はタイマーだけでなく各接続・各操作でも行う。

## インフラとデプロイ

環境ごとの値は `deploy/.env` に置く（`deploy/.env.example` をコピーして埋める。Git には含めない）。`deploy/cloud-run.yaml.tpl` を `deploy/render-cloud-run.sh` が envsubst で展開し、生成物 `deploy/cloud-run.yaml` も Git 管理外とする。Secret のバージョン（`key`）はテンプレート側で固定する。

| 変数 (`deploy/.env`) | 内容 |
| --- | --- |
| `GCP_PROJECT` | GCP プロジェクト ID |
| `GCP_REGION` | リージョン（例: `asia-northeast1`） |
| `CLOUD_RUN_SERVICE` | Cloud Run サービス名 |
| `RUN_SERVICE_ACCOUNT` | 実行用サービスアカウントのメール |
| `CONTAINER_IMAGE` / `IMAGE_TAG` | デプロイするコンテナイメージ URI |
| `QUIZ_PUBLIC_URL` | 公開 HTTPS オリジン（末尾スラッシュなし） |
| `QUIZ_BUCKET` | 問題 ZIP の非公開バケット名 |
| `QUIZ_DATABASE` | Firestore データベース名 |
| `QUIZ_COLLECTION` | Firestore コレクション名 |

実行SAへ付与する権限:

- `roles/datastore.user`: `resource.name == "projects/PROJECT/databases/trans-ai-quiz"` のIAM条件でDBを限定する。
- `roles/storage.objectUser`: 専用バケットのみ。Uniform bucket-level accessとPublic access preventionを有効にする。
- `roles/secretmanager.secretAccessor`: 使用するSecretごと。プロジェクト全体への付与は避ける。
- Cloud Runの呼出しは公開し、主催者・参加者の権限はアプリが確認する。Firestore Security Rulesでクライアント向け公開を許可しない。

Cloud Buildへ送るファイルは `.gcloudignore`、コンテナのビルド対象は `.dockerignore` で限定する。送信前に `gcloud meta list-files-for-upload` で `.env`・問題データ・PoCソース・ローカル依存が含まれないこと、および `sound/*.WAV` が載ることを確認する。`./deploy/submit-build.sh` はデフォルトで 4 つのジングルが揃っていることを要求する（`deploy/.env` の `QUIZ_DEPLOY_REQUIRE_SOUND=0` で緩和できる）。

```bash
cp deploy/.env.example deploy/.env
# deploy/.env を編集する

./deploy/submit-build.sh .
./deploy/render-cloud-run.sh
./deploy/replace-cloud-run.sh
```

`IMAGE_TAG` だけ変えて再デプロイする場合は `deploy/.env` の `CONTAINER_IMAGE` を空にし、`IMAGE_TAG` を更新してから上記の render / replace を実行する。初回はサービスの HTTPS URL を確定後に `QUIZ_PUBLIC_URL` を合わせる。独自ドメインを使う場合も、開くオリジンと設定を一致させる。`/api/health` が 200 になることを確認する。コンテナは非 root で起動し、アクセスログは出さず、キー・Cookie・参加 URL をアプリログに記録しない。

バケット保持設定:

```bash
source deploy/gcloud-env.sh
gcloud storage buckets update "gs://${QUIZ_BUCKET}" \
  --lifecycle-file=deploy/storage-lifecycle.json --soft-delete-duration=7d
```

通常運用で大会中のデプロイは避ける。ロールバックは、前の互換性のあるリビジョンへトラフィックを100%戻す。保存形式が変わる更新では互換性を別途確認する。

```bash
source deploy/gcloud-env.sh
gcloud run services update-traffic "$CLOUD_RUN_SERVICE" --project "$GCP_PROJECT" \
  --region "$GCP_REGION" --to-revisions=PREVIOUS_REVISION=100
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
source deploy/gcloud-env.sh
server/.venv/bin/python server/scripts/verify_cloud_run.py \
  --url "$QUIZ_PUBLIC_URL" \
  --password-file /path/to/private/password.txt \
  --ai --restart-project "$GCP_PROJECT"
```

`--ai` は各社への実API呼出しを行う。`--restart-project` は指定プロジェクトの `trans-ai-quiz` を新リビジョンへ更新する。運用中の大会がある場合は中止し、検証専用大会だけを終了する。主催者パスワードや参加URLは表示しない。
