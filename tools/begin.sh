#!/usr/bin/env bash
# Start a piece of work from the latest state on GitHub (use this first, every time, from any account / chat).
#   bash tools/begin.sh <workdir> <password> [<players' password>]
#   -> <workdir>/secret.json      key for publishing (rebuilt from the published page + password; same as before)
#      <workdir>/secret-player.json  key of the players' page player/ (with the 3rd argument)
#      <workdir>/baseball.sqlite  the latest database (decrypted from backup/baseball.sqlite.enc)
#      <workdir>/app.js, app.css  the page's program, kept inside the database (edit these, then bbdb.cjs set-app)
# The workdir must be outside the repository. Nothing secret is written inside the repository.
set -euo pipefail
WORK="$1"; PW="$2"; PPW="${3:-}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$WORK"
case "$(realpath "$WORK")" in "$REPO"/*) echo "workdir must be outside the repo" >&2; exit 1;; esac
REMOTE_HEAD="$(git -C "$REPO" ls-remote origin main | cut -f1)"
if [ "$(git -C "$REPO" rev-parse HEAD)" != "$REMOTE_HEAD" ]; then
  if [ -n "$(git -C "$REPO" status --porcelain)" ]; then
    echo "このクローンに未公開の変更があります。GitHubが新しくなっているので、変更を退避してから再実行してください。" >&2; git -C "$REPO" status --short >&2; exit 1
  fi
  git -C "$REPO" fetch -q origin main && git -C "$REPO" reset -q --hard FETCH_HEAD
  echo "GitHubの最新（${REMOTE_HEAD:0:7}）に合わせました"
fi
node "$REPO/tools/build.cjs" secret-from-page "$REPO/index.html" "$PW" "$WORK/secret.json" >/dev/null
if [ -f "$REPO/player/index.html" ]; then
  if [ -z "$PPW" ]; then echo "選手用のページ（player/）があります。3つ目に選手用のパスワードを付けて実行してください（公開のときに必要です）。" >&2; exit 1; fi
  node "$REPO/tools/build.cjs" secret-from-page "$REPO/player/index.html" "$PPW" "$WORK/secret-player.json" >/dev/null
fi
rm -f "$WORK/baseball.sqlite"
node "$REPO/tools/build.cjs" decrypt-file "$REPO/backup/baseball.sqlite.enc" "$WORK/baseball.sqlite" "$WORK/secret.json" >/dev/null
node --no-warnings "$REPO/tools/bbdb.cjs" get-app --db "$WORK/baseball.sqlite" --js "$WORK/app.js" --css "$WORK/app.css" >/dev/null
REV="$(node --no-warnings -e "const {DatabaseSync}=require('node:sqlite');console.log(new DatabaseSync(process.argv[1]).prepare(\"SELECT value FROM meta WHERE key='rev'\").get().value)" "$WORK/baseball.sqlite")"
echo "準備できました：$WORK（データ更新 $REV ・ 公開中のコミット ${REMOTE_HEAD:0:7}）"
