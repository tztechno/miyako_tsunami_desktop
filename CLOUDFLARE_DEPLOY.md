# Cloudflare への非公開デプロイ(Web 版)

このリポジトリ(`tztechno/miyako_tsunami_desktop`)のビルド結果 `dist/` を、Cloudflare Workers の静的アセットとして配信します。
アプリはサーバー処理を持たず(津波計算は Web Worker、2m 詳細タイルの作成と住所検索はブラウザから直接、タイルの保存は IndexedDB)、
デスクトップ版と同じビルドがそのままブラウザで動きます。
**公開しない**ため、Cloudflare Access(Zero Trust)でアクセスできる人を限定します。(N74 osaka_tsunami と同じ構成)

## 用意したファイル

| ファイル | 役割 |
|---|---|
| `wrangler.jsonc` | Worker 名 `miyako-tsunami`。`dist/` を静的アセットとして配信(サーバーコードなし) |
| `public/_headers` | キャッシュ設定(ビルド時に `dist/_headers` へコピーされる。デスクトップ版では使われない) |
| `package.json` の `deploy` / `deploy:dry` | `npm run build:web && wrangler deploy`(`:dry` は送信せず検証のみ) |

Cloudflare の静的アセットは 1 ファイル 25 MiB までですが、現在の最大ファイルは `data/regions/taro/ground.f32` と `ground_2011.f32`(各約 6.1 MiB)、
ファイル数は約 55、合計約 45 MB なので分割は不要です(`npm run deploy:dry` で確認済み)。

## A. GitHub 連携で自動デプロイ(推奨)

1. Cloudflare ダッシュボード → **Workers & Pages** → **Create** → **Import a repository**
2. GitHub の `tztechno/miyako_tsunami_desktop` を選ぶ(非公開リポジトリへのアクセスを Cloudflare の GitHub App に許可)
3. ビルド設定

   | 項目 | 値 |
   |---|---|
   | Project name | `miyako-tsunami`(`wrangler.jsonc` の `name` と同じにする) |
   | Production branch | `main` |
   | Build command | `npm run build:web` |
   | Deploy command | `npx wrangler deploy` |
   | Root directory | `/`(リポジトリ直下) |
   | 環境変数 | `NODE_VERSION` = `22` |

4. **Save and Deploy**。以後 `main` に push するたびに自動でデプロイされます
   (Windows インストーラーのビルドは `main` への push では動きません。バージョンタグ `v*` の push か、
   GitHub の Actions 画面からの手動実行のときだけ動きます。`.github/workflows/build-windows.yml`)

## B. 手元からデプロイ

```bash
cd miyako_tsunami_desktop
npm install
npx wrangler login          # 初回のみ(ブラウザで Cloudflare にログイン)
npm run deploy:dry          # 検証のみ(送信しない)
npm run deploy              # ビルドしてデプロイ
```

デプロイ先は `https://miyako-tsunami.<アカウントのサブドメイン>.workers.dev` です。

## 非公開にする(Cloudflare Access)

デプロイしただけでは URL を知っている人は誰でも開けます。必ず Access で保護してください。

1. Cloudflare ダッシュボード → **Workers & Pages** → `miyako-tsunami` → **Settings** → **Domains & Routes**
2. `workers.dev` の行で **Enable Cloudflare Access** を有効にする
   (または **Zero Trust** → **Access** → **Applications** → **Add an application** → **Self-hosted** で
   上記の workers.dev ホスト名を登録)
3. ポリシー(Policy)で **Allow** — **Emails** に利用者のメールアドレス(例: 自分のアドレス)を登録
4. ログイン方法は **One-time PIN**(メールに届くコードでログイン)で十分です
5. `wrangler.jsonc` は `"preview_urls": false` にしてあるので、プレビュー用 URL は作られません

確認: シークレットウィンドウで URL を開き、Access のログイン画面が出ること(登録外のメールでは入れないこと)。

## 動作の前提・注意

- ブラウザは WebGL2 対応のもの(Chrome / Edge / Safari 最新版)。2m 詳細計算は浮動小数点テクスチャへの描画(EXT_color_buffer_float)が必要
- スマホ(画面幅 760px 以下かタッチ操作が主の端末)では、パネルが畳まれた配置で始まり、2m 詳細タイルは 1km のみ
- 住所検索と 2m タイルの作成は、ブラウザから国土地理院・PLATEAU のサーバーへ直接アクセスします(どちらも CORS 許可済み)
- ブラウザで作ったタイルは、そのブラウザの中(IndexedDB)に保存されます。別の PC やブラウザ、デスクトップ版とは共有されません
- 結果 CSV・一括計算の ZIP・MP4 は、ブラウザのダウンロードとして保存されます
- データ(`public/data`)のファイル名は固定なので、`_headers` でキャッシュを 1 時間にしています。更新を push すると、遅くとも 1 時間で反映されます
