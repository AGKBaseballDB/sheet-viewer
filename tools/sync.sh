#!/usr/bin/env bash
# Folder sync for the analysis sheet.
#   bash tools/sync.sh plan  <secret.json> <listing.json> <workdir>
#       -> restores the DB from backup/ into <workdir>/baseball.sqlite and prints {"stage":[...]} (paths to copy from the PC)
#   bash tools/sync.sh apply <secret.json> <listing.json> <workdir>
#       -> imports <workdir>/inbox/<path> files, rebuilds and publishes the page + encrypted DB backup,
#          writes <workdir>/out/取り込み結果.txt and <workdir>/out/baseball.sqlite.gz for the PC
# Optional: CLAUDE_SESSION_URL (commit trailer). The secret, the DB and the inbox must be outside the repo.
set -euo pipefail
MODE="$1"; SECRET="$2"; LISTING="$3"; WORK="$4"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="node --no-warnings"
mkdir -p "$WORK"
case "$(realpath "$WORK")" in "$REPO"/*) echo "workdir must be outside the repo" >&2; exit 1;; esac
DB="$WORK/baseball.sqlite"

if [ ! -f "$DB" ]; then
  node "$REPO/tools/build.cjs" decrypt-file "$REPO/backup/baseball.sqlite.enc" "$DB" "$SECRET" >/dev/null
fi

case "$MODE" in
  plan)
    $NODE "$REPO/tools/bbdb.cjs" plan --db "$DB" --listing "$LISTING"
    ;;
  apply)
    mkdir -p "$WORK/inbox" "$WORK/out"
    $NODE "$REPO/tools/bbdb.cjs" ingest --db "$DB" --listing "$LISTING" --files "$WORK/inbox" --report "$WORK/out/取り込み結果.txt" > "$WORK/ingest.json"
    REV="$($NODE -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).rev)" "$WORK/ingest.json")"
    $NODE "$REPO/tools/bbdb.cjs" export --db "$DB" --out "$WORK/page-source.html" >/dev/null
    if ! BACKUP_DB="$DB" bash "$REPO/tools/deploy.sh" "$WORK/page-source.html" "$SECRET" "db-$REV" > "$WORK/deploy.log" 2>&1; then
      grep -v -E "expected 'acknowledgments'|push negotiation failed" "$WORK/deploy.log" >&2; echo "deploy failed" >&2; exit 1
    fi
    LOCAL="$(git -C "$REPO" rev-parse HEAD)"; REMOTE="$(git -C "$REPO" ls-remote origin main | cut -f1)"
    if [ "$LOCAL" != "$REMOTE" ]; then echo "push did not land (local $LOCAL, remote $REMOTE)" >&2; exit 1; fi
    gzip -c "$DB" > "$WORK/out/baseball.sqlite.gz"
    cat "$WORK/ingest.json"
    ;;
  *) echo "usage: sync.sh plan|apply <secret.json> <listing.json> <workdir>" >&2; exit 2;;
esac
