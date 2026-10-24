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

OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
node "$REPO/tools/build.cjs" build "$SRC" "$OUT" "$SECRET"

# Safety: refuse to publish anything that still looks like plaintext.
for marker in 'id="seed"' 'id="app-js"' '<title>打者'; do
  if grep -qF "$marker" "$OUT/index.html"; then echo "plaintext marker found ($marker); aborting" >&2; exit 1; fi
done

cp "$OUT/index.html" "$OUT/.nojekyll" "$OUT/robots.txt" "$REPO/"
printf '%s\n' "$VERSION" > "$REPO/tools/last-source-version.txt"

# Optional: encrypted backup of the SQLite database (same key as the page).
if [ -n "${BACKUP_DB:-}" ]; then
  case "$(realpath "$BACKUP_DB")" in "$REPO"/*) echo "database must be outside the repo" >&2; exit 1;; esac
  node "$REPO/tools/build.cjs" encrypt-file "$BACKUP_DB" "$REPO/backup/baseball.sqlite.enc" "$SECRET"
  if grep -qF 'SQLite format' "$REPO/backup/baseball.sqlite.enc"; then echo "backup is not encrypted; aborting" >&2; exit 1; fi
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
