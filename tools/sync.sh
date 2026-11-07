#!/usr/bin/env bash
# Folder sync for the analysis sheet.
#   bash tools/sync.sh plan  <secret.json> <listing.json> <workdir>
#       -> restores the DB from backup/ into <workdir>/baseball.sqlite and prints {"stage":[...]} (paths to copy from the PC)
#   bash tools/sync.sh apply <secret.json> <listing.json> <workdir>
#       -> imports <workdir>/inbox/<path> files, rebuilds and publishes the page + encrypted DB backup,
#          writes <workdir>/out/取り込み結果.txt and <workdir>/out/baseball.sqlite.gz for the PC
# Optional: CLAUDE_SESSION_URL (commit trailer). Put the 測定DB workbook at <workdir>/measure.xlsx to update it too
# (result: <workdir>/out/measure.xlsx, only when rows were added). The secret, the DB and the inbox must be outside the repo.
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
    NAMES_ARG=(); [ -f "$WORK/names-pre.json" ] && NAMES_ARG=(--names "$WORK/names-pre.json")
    if [ -f "$WORK/measure.xlsx" ]; then
      python3 -I "$REPO/tools/measure_xlsx.py" --xlsx "$WORK/measure.xlsx" --names-out "$WORK/names.json" --roman-out "$WORK/roman.json" && NAMES_ARG=(--names "$WORK/names.json" --roman "$WORK/roman.json")
    fi
    $NODE "$REPO/tools/bbdb.cjs" ingest --db "$DB" --listing "$LISTING" --files "$WORK/inbox" --report "$WORK/out/取り込み結果.txt" "${NAMES_ARG[@]}" > "$WORK/ingest.json"
    REV="$($NODE -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).rev)" "$WORK/ingest.json")"
    $NODE "$REPO/tools/bbdb.cjs" export --db "$DB" --out "$WORK/page-source.html" >/dev/null
    PS=""; [ -f "$WORK/secret-player.json" ] && [ -z "${STAFF_ONLY:-}" ] && PS="$WORK/secret-player.json"
    if ! BACKUP_DB="$DB" PLAYER_SECRET="$PS" bash "$REPO/tools/deploy.sh" "$WORK/page-source.html" "$SECRET" "db-$REV" > "$WORK/deploy.log" 2>&1; then
      grep -v -E "expected 'acknowledgments'|push negotiation failed" "$WORK/deploy.log" >&2; echo "deploy failed" >&2; exit 1
    fi
    LOCAL="$(git -C "$REPO" rev-parse HEAD)"; REMOTE="$(git -C "$REPO" ls-remote origin main | cut -f1)"
    if [ "$LOCAL" != "$REMOTE" ]; then echo "push did not land (local $LOCAL, remote $REMOTE)" >&2; exit 1; fi
    gzip -c "$DB" > "$WORK/out/baseball.sqlite.gz"
    # Optional: append the new TrackMan / Blast rows to the measurement workbook (WORK/measure.xlsx, staged from the PC)
    if [ -f "$WORK/measure.xlsx" ]; then
      # WORK/measure_inbox/{トラックマン,Blast}: every CSV in those PC folders (rows already in the workbook are skipped),
      # so a file whose Excel step was missed (workbook open) is picked up next time. Falls back to the changed files.
      MI="$WORK/inbox"; [ -d "$WORK/measure_inbox" ] && MI="$WORK/measure_inbox"
      python3 -I "$REPO/tools/measure_xlsx.py" --xlsx "$WORK/measure.xlsx" --out "$WORK/out/measure.xlsx" \
        --tm-dir "$MI/トラックマン" --blast-dir "$MI/Blast" --report "$WORK/out/measure-report.txt" > "$WORK/measure.json"
      cat "$WORK/out/measure-report.txt" >> "$WORK/out/取り込み結果.txt"
    fi
    cat "$WORK/ingest.json"
    ;;
  *) echo "usage: sync.sh plan|apply <secret.json> <listing.json> <workdir>" >&2; exit 2;;
esac
