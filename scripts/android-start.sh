#!/data/data/com.termux/files/usr/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

mkdir -p data
cat certs/*.crt > certs/max-ca.pem

export NODE_EXTRA_CA_CERTS="$PWD/certs/max-ca.pem"
export DATA_DIR="${DATA_DIR:-$PWD/data}"

if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock || true
fi

npm start
