#!/usr/bin/env bash
# GOLDEN FIXTURE — verbatim copy of the relay-to-sibling skill's relay-close.sh
# (CodeStrux/claude-code-skills). closure.test.ts runs it against the same pair
# dirs as rollupPair and compares byte-for-byte; update the copy in lockstep.
#
# relay-close.sh <relay-dir>
#
# Roll every <area>.report.md status block in a relay dir into closure.json.
# Deterministic — no AI. Each report opens with a YAML block:
#
#   ---
#   area: backend
#   status: complete        # complete | partial | blocked
#   steps_done: 5
#   steps_total: 5
#   plan_ref: ~/.claude/plans/<project>/poc-implementation-plan.md
#   ---
#
# Output: <relay-dir>/closure.json  (the pair's machine-readable closure record)
set -euo pipefail

dir="${1:?usage: relay-close.sh <relay-dir>}"
dir="${dir%/}"
[[ -d "$dir" ]] || { echo "relay-close: no such dir: $dir" >&2; exit 1; }
pair="$(basename "$dir")"
out="$dir/closure.json"
generated="$(date -u +%FT%TZ)"

shopt -s nullglob
reports=("$dir"/*.report.md)

if (( ${#reports[@]} == 0 )); then
  printf '{"pair":"%s","generated":"%s","briefs":[],"totals":{"pct":0,"blocked":[]}}\n' "$pair" "$generated" > "$out"
  echo "relay-close: no reports in $dir — wrote empty $out"
  exit 0
fi

awk -v pair="$pair" -v generated="$generated" '
function esc(s){ gsub(/\\/,"\\\\",s); gsub(/"/,"\\\"",s); return s }
function getval(s){ sub(/^[^:]*:[ \t]*/,"",s); sub(/[ \t]+#.*$/,"",s); gsub(/^[ \t]+|[ \t]+$/,"",s); return s }
function flush(   p){
  if (area=="") return
  p = (total>0) ? int(done*100/total) : (status=="complete" ? 100 : 0)
  briefs[nb++] = sprintf("{\"area\":\"%s\",\"status\":\"%s\",\"steps_done\":%d,\"steps_total\":%d,\"pct\":%d,\"plan_ref\":\"%s\"}", esc(area), esc(status), done, total, p, esc(plan_ref))
  sumdone += done; sumtotal += total
  if (status=="blocked") blocked[nbk++] = sprintf("\"%s\"", esc(area))
  area=""; status=""; done=0; total=0; plan_ref=""
}
FNR==1 { flush(); infm=0 }
/^---[ \t]*$/ { infm = !infm; next }
infm {
  if      ($1=="area:")        area=getval($0)
  else if ($1=="status:")      status=getval($0)
  else if ($1=="steps_done:")  done=getval($0)+0
  else if ($1=="steps_total:") total=getval($0)+0
  else if ($1=="plan_ref:")    plan_ref=getval($0)
}
END {
  flush()
  tp = (sumtotal>0) ? int(sumdone*100/sumtotal) : 0
  printf "{\"pair\":\"%s\",\"generated\":\"%s\",\"briefs\":[", esc(pair), generated
  for (i=0;i<nb;i++) printf "%s%s", (i?",":""), briefs[i]
  printf "],\"totals\":{\"pct\":%d,\"blocked\":[", tp
  for (i=0;i<nbk;i++) printf "%s%s", (i?",":""), blocked[i]
  printf "]}}\n"
}
' "${reports[@]}" > "$out"

echo "relay-close: wrote $out"
