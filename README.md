# きょうの予定

Google アカウントでログインし、Google カレンダーの **今日の予定** を一覧表示する Web アプリです。
iPhone の Safari から「ホーム画面に追加」すると、アプリのように全画面で起動できます (PWA)。

- ビルド不要の静的サイト (HTML / CSS / JavaScript のみ)
- サーバー不要。ブラウザから直接 Google Calendar API を呼び出します
- 権限は読み取り専用 (`calendar.readonly`)
- Google カレンダーで表示中のすべてのカレンダーの予定をまとめて表示（自分が「不参加」にした予定は除外）
- 進行中の予定を強調、終了した予定は薄く表示。タップで Google カレンダーの予定を開く
- ダークモード対応、オフライン時もアプリ画面は起動

## ファイル構成

| ファイル | 役割 |
| --- | --- |
| `index.html` | 画面 |
| `styles.css` | 見た目 |
| `app.js` | ログイン処理・予定の取得と表示 |
| `config.js` | OAuth クライアント ID の設定 |
| `manifest.webmanifest`, `icons/` | ホーム画面用の名前・アイコン |
| `sw.js` | Service Worker (アプリ本体のオフラインキャッシュ) |
| `.github/workflows/pages.yml` | GitHub Pages への自動デプロイ |

## セットアップ

### 1. 公開 URL を決める（GitHub Pages）

iPhone のホーム画面アプリと Google ログインには HTTPS が必要です。

1. GitHub のリポジトリ → **Settings → Pages → Build and deployment → Source** を **GitHub Actions** にする
2. `main`（または `master`）ブランチに push すると自動デプロイされます
3. 公開 URL は `https://<ユーザー名>.github.io/<リポジトリ名>/` になります
   （例: `https://imakara-max.github.io/super-app/`）

> GitHub Pages は無料プランの場合、公開リポジトリでのみ利用できます。

### 2. Google Cloud で OAuth クライアントを作る

1. [Google Cloud Console](https://console.cloud.google.com/) でプロジェクトを作成
2. **API とサービス → ライブラリ** で「Google Calendar API」を有効化
3. **Google Auth Platform（OAuth 同意画面）** を設定
   - ユーザーの種類: 外部
   - スコープ: `.../auth/calendar.readonly`, `openid`, `email`
   - 公開ステータスが「テスト」の間は、**テストユーザー** に自分の Google アカウントを追加
4. **クライアント → クライアントを作成**
   - アプリケーションの種類: **ウェブ アプリケーション**
   - 承認済みの JavaScript 生成元: `https://<ユーザー名>.github.io`
   - 承認済みのリダイレクト URI: `https://<ユーザー名>.github.io/<リポジトリ名>/`（**末尾のスラッシュまで完全一致**）
   - ローカル確認用に `http://localhost:8000` と `http://localhost:8000/` も追加しておくと便利
5. 発行された **クライアント ID** を `config.js` の `GOOGLE_CLIENT_ID` に貼り付けて push

クライアント ID は公開されても問題ない値です（クライアントシークレットは使いません）。

### 3. iPhone のホーム画面に追加

1. iPhone の **Safari** で公開 URL を開く
2. 共有ボタン → **ホーム画面に追加**
3. ホーム画面のアイコンから起動し、「Google でログイン」

## ローカルで動かす

```sh
python3 -m http.server 8000
# http://localhost:8000/ を開く
```

## 仕組みと制限（v1）

- ログインは OAuth 2.0 のリダイレクト方式（トークンのみ・ブラウザ完結）です。
  iOS のホーム画面アプリではポップアップが不安定なため、ページ遷移で Google の画面に移動して戻ってきます。
- アクセストークンの有効期限は約 1 時間です。期限切れ後にアプリを開くと、
  自動で再取得を試みます（Google 側でログイン済みなら操作不要。画面が一瞬切り替わります）。
  再取得できない場合はログインボタンが表示されます。
- トークンはその端末のブラウザ (localStorage) にのみ保存され、外部サーバーには送信しません。

### 今後の改善案

- 明日以降・週表示、日付の切り替え
- 表示するカレンダーの選択
- バックエンドを用意してリフレッシュトークンで長期ログインを維持
- 予定の通知
