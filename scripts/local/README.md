# Mac에서 Bulbapedia 자동 수집

Bulbapedia는 GitHub Actions 서버 접속을 막기 때문에(403), Bulbapedia 단계만 Mac에서 돌린다.
Showdown 수집은 GitHub Actions(`.github/workflows/ingest-nightly.yml`)가 맡는다.

## 동작

- Mac에 로그인할 때, 그리고 켜져 있는 동안 1시간마다 `run-bulbapedia.sh`가 불린다.
- 오늘(한국 시간) 이미 성공했으면 바로 끝난다. 실패하면 1시간 뒤 다시 시도한다(하루 최대 6번).
- 바뀐 기술 문서만 판 번호로 확인하므로, 며칠 꺼져 있었어도 켜면 한 번에 따라잡는다.
- 하는 일: 기술 문서·사용 가능 표 수집 → 수치·사용 가능 여부 제안 생성 (`ingest` 스키마에만 쓴다)
- 실행 위치는 `~/.poke-mumu-ingest` (실행용 사본). macOS는 백그라운드 작업이
  데스크톱 폴더를 읽지 못하게 막아서 데스크톱 밖에 둔다. 실행할 때마다 `git pull`로 최신 스크립트를 받는다.

## 등록 · 해제

이 저장소 폴더에서 터미널로:

```bash
bash scripts/local/install-mac.sh             # 등록 (.env.local을 바꾼 뒤에도 다시 실행)
bash scripts/local/install-mac.sh --uninstall # 해제
```

## 확인

```bash
cat ~/.poke-mumu-ingest/.local-state/last-success          # 마지막 성공 날짜
tail -n 30 ~/.poke-mumu-ingest/.local-state/logs/$(date +%F).log
launchctl print gui/$(id -u)/com.jomoo02.poke-mumu-ingest.bulbapedia | head -20
```

수동으로 지금 한 번 돌리기 (오늘 성공 기록을 지운 뒤):

```bash
rm -f ~/.poke-mumu-ingest/.local-state/last-success ~/.poke-mumu-ingest/.local-state/attempts-*
bash ~/.poke-mumu-ingest/scripts/local/run-bulbapedia.sh
```
