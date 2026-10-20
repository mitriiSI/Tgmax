#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

pkg update
pkg install -y nodejs python openssl-tool termux-api
pkg install -y ffmpeg || echo "ffmpeg was not installed. The bridge will still run, but video-note/GIF/sticker conversion may be limited."

npm install --no-bin-links

mkdir -p data
cat certs/*.crt > certs/max-ca.pem

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "Created .env from .env.example. Fill it with your tokens before starting."
fi

echo
echo "Android dependencies are installed."
echo "Start the bridge with: bash scripts/android-start.sh"
