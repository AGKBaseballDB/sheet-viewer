# sheet-viewer

閲覧用ページです。公開されているのは暗号化済みのデータだけで、パスワードを知っている人のブラウザ内でのみ復号・表示されます。

- `index.html` — パスワード入力画面と暗号化データ（PBKDF2-SHA256 60万回 → AES-256-GCM）
- `backup/baseball.sqlite.enc` — データベース（SQLite）の暗号化バックアップ（同じパスワードで復元）
- `tools/` — 取り込み・ページ作成・公開のスクリプト（鍵・元データ・アプリ本体は含みません）
  - `bbdb.cjs` — SQLiteデータベースの作成、フォルダのExcel/CSV取り込み、ページの書き出し
  - `build.cjs` / `deploy.sh` — 暗号化と公開
  - `vendor/` — Papa Parse (MIT)、SheetJS (Apache-2.0)、JSZip (MIT) の同梱版

バックアップの復元: `node tools/build.cjs decrypt-file backup/baseball.sqlite.enc baseball.sqlite '<パスワード>'`
