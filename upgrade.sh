#!/usr/bin/env bash
# accio-proxy upgrade script
# Run: npm run upgrade  (or bash upgrade.sh)
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
PKG="$DIR/package.json"

if [ ! -f "$PKG" ]; then
  echo "❌ package.json não encontrado em $DIR"
  exit 1
fi

OLD_VERSION=$(node -e "console.log(require('$PKG').version || 'unknown')")
echo "📦 Versão atual: $OLD_VERSION"

if [ -d "$DIR/.git" ]; then
  echo "🔄 git pull…"
  cd "$DIR"
  git pull --ff-only
else
  echo "⚠️  Not a git repo. Clone it first."
  exit 0
fi

NEW_VERSION=$(node -e "console.log(require('$PKG').version || 'unknown')")
echo "📦 Nova versão: $NEW_VERSION"

echo "📥 npm install…"
cd "$DIR"
npm install

echo "✅ Upgrade concluído. ($OLD_VERSION → $NEW_VERSION)"
