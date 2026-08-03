# 小説執筆

iPhoneとPCで使える、軽量な小説執筆PWAです。本文は軽量な`textarea`で編集し、IndexedDBを一次保存先にします。

## 安全性について

PINロックは、端末を一時的に触った人から表示を隠すためのアプリ内ロックです。PINはソルト付きSHA-256ハッシュで保存しますが、原稿自体の端末暗号化・エンドツーエンド暗号化は行いません。端末やブラウザのプロフィールへアクセスできる人に対する強固な防御ではありません。

## Supabase

`.env.example`を`.env.local`へコピーしてURLとanonキーを設定し、`supabase/migrations`のSQLを適用してください。service roleキーはフロントエンドへ設定しないでください。

## 開発

`npm run dev`で起動し、`npm run build`で本番ビルドを確認できます。

## GitHub Pages

`npm run build:github`で、ChatGPT認証に依存しない静的版を`github-dist`へ生成します。GitHub Pagesでは原稿はブラウザのIndexedDBにだけ保存され、リポジトリへは送信されません。公開リポジトリへpushすると、`.github/workflows/pages.yml`が自動でPagesへ公開します。
