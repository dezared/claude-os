#!/usr/bin/env bash
# rgc: ripgrep that answers "where should I look first": ranked files, then the best matches in context, within a budget.
set -u

top=5 context=2 budget=120 def=0
while [ $# -gt 0 ]; do
  case "$1" in
    --top) top=$2; shift 2 ;;
    --context) context=$2; shift 2 ;;
    --budget) budget=$2; shift 2 ;;
    --def) def=1; shift ;;
    --) shift; break ;;
    -*) echo "rgc: unknown option $1" >&2; exit 2 ;;
    *) break ;;
  esac
done
if [ $# -lt 1 ]; then
  echo 'usage: rgc.sh [--def] [--top N] [--context N] [--budget LINES] PATTERN [PATH...]' >&2
  exit 2
fi
command -v rg >/dev/null || { echo 'rgc: ripgrep (rg) is not installed' >&2; exit 2; }

pattern=$1
shift
[ $# -gt 0 ] || set -- .
if [ "$def" = 1 ]; then
  pattern="\\b(function|def|class|interface|trait|enum|struct|type|const|let|var|fn|func|impl|module)\\s+$pattern\\b|^\\s*(export\\s+)?(public\\s+|private\\s+|protected\\s+|static\\s+|async\\s+)*$pattern\\s*(\\(.*\\)\\s*\\{|=\\s*(async\\s*)?\\(|\\(\\)\\s*\\{)"
fi

flags=(--smart-case --no-messages --glob '!**/node_modules/**' --glob '!**/dist/**' --glob '!**/build/**' --glob '!**/vendor/**' --glob '!**/.git/**' --glob '!**/*.lock' --glob '!**/package-lock.json' --glob '!**/*.min.*' --glob '!**/*.map')

# path<TAB>count, most matches first; tests, docs and fixtures sort after source at the same count.
ranked=$(rg --count-matches --with-filename "${flags[@]}" -e "$pattern" -- "$@" | awk '{
  n = match($0, /:[0-9]+$/); path = substr($0, 1, n - 1); count = substr($0, n + 1) + 0
  lesser = path ~ /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|docs?|samples?|examples?)\// || path ~ /\.(test|spec)\.|\.md$/
  printf "%d\t%d\t%s\n", count, lesser ? 0 : 1, path
}' | sort -t "$(printf '\t')" -k1,1nr -k2,2nr -k3,3)
if [ -z "$ranked" ]; then
  echo 'no matches' >&2
  exit 1
fi

files=$(printf '%s\n' "$ranked" | wc -l)
total=$(printf '%s\n' "$ranked" | awk -F '\t' '{ s += $1 } END { print s }')
echo "$total matches in $files files"
printf '%s\n' "$ranked" | head -n 15 | awk -F '\t' '{ printf "  %5d  %s\n", $1, $3 }'
[ "$files" -le 15 ] || echo "  ... and $((files - 15)) more"
echo

left=$budget shown=0
while IFS=$'\t' read -r _ _ path; do
  [ "$shown" -lt "$top" ] && [ "$left" -gt 0 ] || break
  echo "== $path"
  block=$(rg --line-number --context "$context" --max-count 8 --no-heading "${flags[@]}" -e "$pattern" -- "$path" | head -n "$left")
  printf '%s\n\n' "$block"
  left=$((left - $(printf '%s\n' "$block" | wc -l) - 2))
  shown=$((shown + 1))
done <<< "$ranked"

[ "$shown" -ge "$files" ] || echo "showed $shown of $files files; narrow the path or raise --top and --budget for the rest"
