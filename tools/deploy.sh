#!/usr/bin/env bash
# Rebuild the encrypted viewer page from the source sheet HTML and publish it.
# Usage: bash tools/deploy.sh <source.html> <secret.json> <source-version>
# - The source HTML and secret.json must stay OUTSIDE this repository.
# - Publishes as a single commit (force-push) so old ciphertexts do not pile up in history.
# - Optional: CLAUDE_SESSION_URL=<url> adds a Claude-Session line to the commit message.
set -euo pipefail
SRC="$1"; SECRET="$2"; VERSION="${3:-manual}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
case "$(realpath "$SRC")" in "$REPO"/*) echo "source must be outside the repo" >&2; exit 1;; esac
case "$(realpath "$SECRET")" in "$REPO"/*) echo "secret must be outside the repo" >&2; exit 1;; esac

# Guard: refuse when GitHub changed since this clone last published or was refreshed (another account / chat published).
# Start every piece of work with tools/begin.sh, which takes the latest page and database from GitHub.
LOCAL_HEAD="$(git -C "$REPO" rev-parse HEAD)"; REMOTE_HEAD="$(git -C "$REPO" ls-remote origin main | cut -f1)"
if [ -n "$REMOTE_HEAD" ] && [ "$LOCAL_HEAD" != "$REMOTE_HEAD" ] && [ -z "${FORCE_OVER_REMOTE:-}" ]; then
  echo "GitHubの内容が作業を始めたときから変わっています（別のアカウントやチャットが公開した可能性があります）。" >&2
  echo "tools/begin.sh で最新のページとデータベースを取り直し、変更をやり直してから公開してください。" >&2
  exit 3
fi
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
node "$REPO/tools/build.cjs" build "$SRC" "$OUT" "$SECRET"

# Safety: refuse to publish anything that still looks like plaintext.
for marker in 'id="seed"' 'id="app-js"' '<title>打者'; do
  if grep -qF "$marker" "$OUT/index.html"; then echo "plaintext marker found ($marker); aborting" >&2; exit 1; fi
done

cp "$OUT/index.html" "$OUT/.nojekyll" "$OUT/robots.txt" "$REPO/"

# The players' page (player/index.html): the same page with its own password (PLAYER_SECRET = its secret.json).
# Once it exists it must be rebuilt on every publish, so it never shows older data than the staff page.
if [ -n "${PLAYER_SECRET:-}" ]; then
  case "$(realpath "$PLAYER_SECRET")" in "$REPO"/*) echo "player secret must be outside the repo" >&2; exit 1;; esac
  if [ "$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).key===JSON.parse(require('fs').readFileSync(process.argv[2],'utf8')).key)" "$SECRET" "$PLAYER_SECRET")" = true ]; then echo "player and staff keys must differ" >&2; exit 1; fi
  POUT="$(mktemp -d)"
  node "$REPO/tools/build.cjs" build "$SRC" "$POUT" "$PLAYER_SECRET" >/dev/null
  for marker in 'id="seed"' 'id="app-js"' '<title>打者'; do
    if grep -qF "$marker" "$POUT/index.html"; then echo "plaintext marker found in the players' page ($marker); aborting" >&2; rm -rf "$POUT"; exit 1; fi
  done
  mkdir -p "$REPO/player"; cp "$POUT/index.html" "$POUT/robots.txt" "$REPO/player/"; rm -rf "$POUT"
elif [ -n "${STAFF_ONLY:-}" ]; then
  echo "スタッフ用だけ公開します（選手用 player/ は前のまま）" >&2
elif [ -f "$REPO/player/index.html" ]; then
  echo "選手用のページ（player/）があるので、PLAYER_SECRET（選手用の secret.json）を付けて公開してください。tools/begin.sh に選手用のパスワードを渡すと作業フォルダに secret-player.json ができます。" >&2; exit 4
fi
printf '%s\n' "$VERSION" > "$REPO/tools/last-source-version.txt"

# Optional: encrypted backup of the SQLite database (same key as the page).
if [ -n "${BACKUP_DB:-}" ]; then
  case "$(realpath "$BACKUP_DB")" in "$REPO"/*) echo "database must be outside the repo" >&2; exit 1;; esac
  node "$REPO/tools/build.cjs" encrypt-file "$BACKUP_DB" "$REPO/backup/baseball.sqlite.enc" "$SECRET"
  if grep -qF 'SQLite format' "$REPO/backup/baseball.sqlite.enc"; then echo "backup is not encrypted; aborting" >&2; exit 1; fi
fi
# PDFs of the body reports: docs/<id>.enc (encrypted with the documents key kept in the DB, which both pages carry inside
# their encrypted data; existing files are kept, stale ones removed)
if [ -n "${BACKUP_DB:-}" ]; then
  node --no-warnings "$REPO/tools/bbdb.cjs" export-docs --db "$BACKUP_DB" --secret "$SECRET" --out "$REPO/docs" >/dev/null
  if [ -d "$REPO/docs" ] && grep -l '%PDF' "$REPO"/docs/* >/dev/null 2>&1; then echo "a document is not encrypted; aborting" >&2; exit 1; fi
fi

# Game clips (clips/<id>.mp4.enc, added by bbdb.cjs add-clips and kept in the repository): must be encrypted
if [ -d "$REPO/clips" ]; then
  for f in "$REPO"/clips/*; do [ -f "$f" ] || continue
    if head -c 64 "$f" | grep -qa 'ftyp'; then echo "a clip is not encrypted ($f); aborting" >&2; exit 1; fi
  done
fi

cd "$REPO"
MSG_TRAILER="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
if [ -n "${CLAUDE_SESSION_URL:-}" ]; then MSG_TRAILER="$MSG_TRAILER
Claude-Session: $CLAUDE_SESSION_URL"; fi
git checkout -q --orphan publish-tmp
git add -A
git -c user.name=AGKBaseballDB -c user.email=238694780+AGKBaseballDB@users.noreply.github.com \
  commit -q -m "Update viewer page ($VERSION)" -m "$MSG_TRAILER"
git push -q -f origin HEAD:main
git branch -D main >/dev/null 2>&1 || true
git branch -m main
echo "deployed version $VERSION"
