#!/bin/sh
# All arguments come from the main process after artifact and bundle verification.
set -eu
parent_pid=$1
staged=$2
target=$3
backup=$4
log=$5
exec >> "$log" 2>&1
attempt=0
while kill -0 "$parent_pid" 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -gt 60 ]; then echo 'Local DB Viewer did not exit; update canceled'; exit 1; fi
  sleep 1
done
if [ ! -d "$staged/Contents/MacOS" ] || [ ! -d "$target/Contents/MacOS" ] || [ -e "$backup" ]; then
  echo 'Invalid installation paths'; exit 1
fi
/bin/mv "$target" "$backup"
if ! /bin/mv "$staged" "$target"; then
  /bin/mv "$backup" "$target"
  /usr/bin/open -n "$target"
  exit 1
fi
if ! /usr/bin/open -n "$target"; then
  /bin/mv "$target" "$staged"
  /bin/mv "$backup" "$target"
  /usr/bin/open -n "$target"
  exit 1
fi
echo 'Local DB Viewer updated; previous version retained at' "$backup"
