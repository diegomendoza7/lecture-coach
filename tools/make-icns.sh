#!/bin/bash
# build/icon.png (from make-icon.js) -> build/icon.icns
set -e
cd "$(dirname "$0")/.."
sips -Z 1024 build/icon.png --out build/icon.png >/dev/null
rm -rf build/icon.iconset && mkdir -p build/icon.iconset
while IFS=' ' read -r px name; do
  [ -z "$px" ] && continue
  sips -z "$px" "$px" build/icon.png --out "build/icon.iconset/icon_${name}.png" >/dev/null
done <<'SIZES'
16 16x16
32 16x16@2x
32 32x32
64 32x32@2x
128 128x128
256 128x128@2x
256 256x256
512 256x256@2x
512 512x512
1024 512x512@2x
SIZES
iconutil -c icns build/icon.iconset -o build/icon.icns
rm -rf build/icon.iconset
echo "wrote build/icon.icns"
