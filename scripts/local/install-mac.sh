#!/bin/bash
# Mac에 Bulbapedia 자동 수집을 등록한다. 이 저장소 폴더에서 터미널로 한 번 실행한다.
#
#   bash scripts/local/install-mac.sh            등록 (다시 실행하면 갱신)
#   bash scripts/local/install-mac.sh --uninstall 해제
#
# 하는 일
# 1. ~/.poke-mumu-ingest 에 실행용 사본을 만든다 (GitHub에서 clone, 이후 실행마다 git pull)
#    macOS는 백그라운드 작업이 데스크톱 폴더를 읽지 못하게 막아서 데스크톱 밖에 둔다.
# 2. 이 폴더의 .env.local을 실행용 사본에 복사한다 (본인만 읽기 권한)
# 3. 지금 터미널의 node·pnpm 경로를 기록한다 (launchd는 셸 설정을 읽지 않는다)
# 4. launchd에 등록한다: 로그인할 때와 1시간마다 실행, 하루 한 번만 실제로 수집
set -euo pipefail

LABEL="com.jomoo02.poke-mumu-ingest.bulbapedia"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TARGET="$HOME/.poke-mumu-ingest"
REPO_URL="https://github.com/jomoo02/poke-mumu-ingest.git"
SRC="$(cd "$(dirname "$0")/../.." && pwd)"

if [ "${1:-}" = "--uninstall" ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "해제했습니다. 실행용 사본은 남겨 두었습니다: $TARGET (지우려면 rm -rf $TARGET)"
  exit 0
fi

# node 버전 확인 (.mts를 바로 실행하려면 22.18 이상)
NODE_BIN="$(command -v node || true)"
PNPM_BIN="$(command -v pnpm || true)"
[ -n "$NODE_BIN" ] || { echo "node를 찾을 수 없습니다"; exit 1; }
[ -n "$PNPM_BIN" ] || { echo "pnpm을 찾을 수 없습니다"; exit 1; }
"$NODE_BIN" -e '
  const [a, b] = process.versions.node.split(".").map(Number);
  if (a < 22 || (a === 22 && b < 18)) { console.error(`node ${process.versions.node}: 22.18 이상이 필요합니다`); process.exit(1); }
'
[ -f "$SRC/.env.local" ] || { echo "$SRC/.env.local 이 없습니다"; exit 1; }

echo "1/4 실행용 사본 준비: $TARGET"
if [ -d "$TARGET/.git" ]; then
  git -C "$TARGET" pull --ff-only -q
else
  git clone -q "$REPO_URL" "$TARGET"
fi

echo "2/4 .env.local 복사"
install -m 600 "$SRC/.env.local" "$TARGET/.env.local"

echo "3/4 node·pnpm 경로 기록, 패키지 설치"
mkdir -p "$TARGET/.local-state/logs"
printf 'NODE_BIN=%q\nPNPM_BIN=%q\n' "$NODE_BIN" "$PNPM_BIN" > "$TARGET/.local-state/env"
(cd "$TARGET" && "$PNPM_BIN" install --frozen-lockfile --silent)

echo "4/4 launchd 등록"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$TARGET/scripts/local/run-bulbapedia.sh</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>3600</integer>
  <key>StandardOutPath</key><string>$TARGET/.local-state/launchd.log</string>
  <key>StandardErrorPath</key><string>$TARGET/.local-state/launchd.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo
echo "등록했습니다. 지금 바로 한 번 실행되고, 이후 Mac이 켜져 있는 동안 1시간마다 확인합니다(하루 한 번만 수집)."
echo "오늘 로그: $TARGET/.local-state/logs/$(TZ=Asia/Seoul date +%F).log"
echo ".env.local을 바꾸면 이 스크립트를 다시 실행하세요."
