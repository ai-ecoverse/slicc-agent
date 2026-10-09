#!/bin/bash
d="$PWD"
while [ "$d" != "/" ] && [ ! -d "$d/.git" ]; do d="$(dirname "$d")"; done
if [ ! -d "$d/.git" ]; then echo "fatal: not a git repository" >&2; exit 128; fi
root="$d"
if [ "$1" = "--no-optional-locks" ]; then shift; fi
echo "$root $*" >> /tmp/fake-git.log
case "$1" in
  rev-parse) echo "$root" ;;
  status) if [ -f "$root/.git/status" ]; then tr '\n' '\000' < "$root/.git/status"; fi ;;
  show) cat "$root/.git/index-files/${2#:}" 2>/dev/null || exit 128 ;;
  add) drop="$4" ;;
  restore)
    if [ "$3" = "locked.txt" ]; then echo "error: unable to restore $3" >&2; exit 1; fi
    cp "$root/.git/index-files/$3" "$root/$3"
    drop="$3" ;;
  *) exit 1 ;;
esac
if [ -n "$drop" ]; then
  : > "$root/.git/next"
  while IFS= read -r line; do
    if [ "${line:3}" != "$drop" ]; then echo "$line" >> "$root/.git/next"; fi
  done < "$root/.git/status"
  cp "$root/.git/next" "$root/.git/status"
fi
