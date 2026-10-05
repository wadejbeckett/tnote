#!/bin/sh
# Builds tnote.xpi from src/ plus the licence, skipping hidden and backup files.
set -e
cd "$(dirname "$0")"
rm -f tnote.xpi
(cd src && zip -qrX ../tnote.xpi . -x '.*' -x '*/.*' -x '*~' -x '*.bak' -x '*.swp' -x '*#*' -x '*.orig')
zip -qjX tnote.xpi LICENSE
echo "Built $(pwd)/tnote.xpi"
