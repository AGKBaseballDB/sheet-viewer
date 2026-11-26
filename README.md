# sheet-viewer

閲覧用ページです。公開されているのは暗号化済みのデータだけで、パスワードを知っている人のブラウザ内でのみ復号・表示されます。

- `index.html` — パスワード入力画面と暗号化データ（PBKDF2-SHA256 60万回 → AES-256-GCM）
- `backup/baseball.sqlite.enc` — データベース（SQLite）の暗号化バックアップ（同じパスワードで復元）
- `tools/HANDOFF.md` — 引き継ぎメモ（どのアカウント・チャットからでも同じ手順で更新・編集するため）
- `tools/` — 取り込み・ページ作成・公開のスクリプト（鍵・元データ・アプリ本体は含みません）
  - `begin.sh` — 作業の最初に、GitHubの最新のページとデータベースを取り直す（パスワードから公開用の鍵も作り直す）
  - `bbdb.cjs` — SQLiteデータベースの作成、フォルダのExcel/CSV取り込み、ページの書き出し
  - `lib/blast.cjs` — Blast Connect「All swings by player」CSVの取り込み（DBの blast_swings 表・v_blast_daily ビュー）。ページの「野手 → Blast」に表示
  - `lib/schedule.cjs` — フォルダ直下の「試合日程.xlsx」（日付・時刻・大会・チーム1・チーム2・球場・動画URL・メモ）の取り込み（DBの schedule 表。取り込み後もファイルは残す）。ページの「試合日程」に表示
  - `measure_xlsx.py` — 測定DB（Excel）の Trackmandata / Blast シートに新しい行を追記（Blastは時刻でトラックマンの投球と結びつけ TRPitchNo.・選手名を入れる）。他のシートやExcelの設定には触れない
  - `build.cjs` / `deploy.sh` — 暗号化と公開
  - `vendor/` — Papa Parse (MIT)、SheetJS (Apache-2.0)、JSZip (MIT) の同梱版

バックアップの復元: `node tools/build.cjs decrypt-file backup/baseball.sqlite.enc baseball.sqlite '<パスワード>'`
