#!/bin/bash
# Bulbapedia 수집을 하루 한 번 돌린다 (Mac launchd가 Mac이 켜질 때와 1시간마다 부른다).
#
# - Bulbapedia가 GitHub Actions 서버 접속을 막아서, 이 단계만 집 회선의 Mac에서 돌린다.
# - 오늘(한국 시간) 이미 성공했으면 바로 끝난다. 실패하면 다음 호출(1시간 뒤)에 다시 시도한다.
# - 바뀐 문서만 판 번호로 확인하므로 며칠 꺼져 있었어도 한 번에 따라잡는다.
# - 실행 위치는 ~/.poke-mumu-ingest (install-mac.sh가 만든 실행용 사본).
#   macOS는 백그라운드 작업이 데스크톱 폴더를 읽지 못하게 막기 때문이다.
set -u

# 실행 중에 git pull이 이 파일을 바꿔도 안전하도록, 전체를 함수로 읽어 둔 뒤 실행한다
main() {

  ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
  STATE="$ROOT/.local-state"
  mkdir -p "$STATE/logs"

  TODAY="$(TZ=Asia/Seoul date +%F)"
  LOG="$STATE/logs/$TODAY.log"
  log() { echo "[$(TZ=Asia/Seoul date '+%F %T')] $*" >> "$LOG"; }

  # 오늘 이미 성공했으면 끝
  if [ "$(cat "$STATE/last-success" 2>/dev/null)" = "$TODAY" ]; then
    exit 0
  fi

  # 동시에 두 번 돌지 않게 한다 (3시간 넘은 잠금은 비정상 종료로 보고 지운다)
  LOCK="$STATE/lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +180 2>/dev/null)" ]; then
      rmdir "$LOCK" 2>/dev/null
      mkdir "$LOCK" 2>/dev/null || exit 0
    else
      exit 0
    fi
  fi
  trap 'rmdir "$LOCK" 2>/dev/null' EXIT

  # install-mac.sh가 기록한 node·pnpm 경로 (launchd는 셸 설정을 읽지 않는다)
  # shellcheck source=/dev/null
  . "$STATE/env" || { log "설정 없음: install-mac.sh를 다시 실행하세요"; exit 1; }

  # 네트워크가 아직 안 붙었으면(막 깨어난 직후 등) 다음 호출에 다시 시도
  if ! /usr/bin/curl -fsS -o /dev/null --max-time 15 \
    -A 'poke-mumu-ingest/0.1 (+https://github.com/jomoo02/poke-mumu-ingest)' \
    'https://bulbapedia.bulbagarden.net/w/api.php?action=query&meta=siteinfo&format=json'; then
    log "Bulbapedia에 연결되지 않음 → 다음에 다시 시도"
    exit 0
  fi

  cd "$ROOT" || exit 1

  # 하루 최대 6번까지만 시도한다 (계속 실패하면 내일 다시)
  ATTEMPTS_FILE="$STATE/attempts-$TODAY"
  ATTEMPTS="$(cat "$ATTEMPTS_FILE" 2>/dev/null || echo 0)"
  if [ "$ATTEMPTS" -ge 6 ]; then
    exit 0
  fi
  echo $((ATTEMPTS + 1)) > "$ATTEMPTS_FILE"
  find "$STATE" -maxdepth 1 -name 'attempts-*' ! -name "attempts-$TODAY" -delete 2>/dev/null

  log "===== 수집 시작 ($((ATTEMPTS + 1))번째 시도) ====="

  # 저장소 최신 스크립트 받기 (공개 저장소라 로그인 없이 된다)
  OLD_LOCK_HASH="$(/usr/bin/shasum pnpm-lock.yaml 2>/dev/null)"
  if ! /usr/bin/git pull --ff-only -q >> "$LOG" 2>&1; then
    log "git pull 실패 → 지금 있는 스크립트로 진행"
  fi
  if [ "$OLD_LOCK_HASH" != "$(/usr/bin/shasum pnpm-lock.yaml 2>/dev/null)" ] || [ ! -d node_modules/postgres ]; then
    log "패키지 설치"
    "$PNPM_BIN" install --frozen-lockfile >> "$LOG" 2>&1 || { log "pnpm install 실패"; exit 1; }
  fi

  run() {
    log "▶ $*"
    "$NODE_BIN" --env-file=.env.local "$@" >> "$LOG" 2>&1
  }

  ok=1
  run scripts/ingest/fetch-move-snapshot.mts --changed-only || ok=0
  run scripts/ingest/fetch-availability-snapshot.mts || ok=0
  # 원문 수집이 일부 실패해도 이미 받은 원문으로 제안은 만든다
  run scripts/ingest/generate-bulbapedia-move-proposals.mts --phase=values || ok=0
  run scripts/ingest/generate-availability-proposals.mts || ok=0

  if [ "$ok" = 1 ]; then
    echo "$TODAY" > "$STATE/last-success"
    log "===== 성공 ====="
  else
    log "===== 일부 실패 → 1시간 뒤 다시 시도 ====="
  fi

  # 30일 지난 로그 정리
  find "$STATE/logs" -name '*.log' -mtime +30 -delete 2>/dev/null
  exit 0
}

main "$@"
exit $?
