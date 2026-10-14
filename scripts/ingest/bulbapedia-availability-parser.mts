/**
 * Bulbapedia "List of moves by availability in Generation N" 표(wikitext) 해석.
 *
 * 표 형식 (2026-10 기준)
 *   ! {{gameabbrev7|SM}}  ← 게임 열 머리글 (순서대로)
 *   |-
 *   | 1
 *   | {{m|Pound}}
 *   {{typetable|Normal}}
 *   {{statustable|Physical}}
 *   | 35            (PP)
 *   | 40            (위력)
 *   | 100%          (명중)
 *   | {{yes}}       ← 게임 열마다 하나: {{yes}} = 사용 가능, {{no}}·빈칸 = 사용 불가
 *   | {{yes}}<br><small>3.0.0+</small>   (업데이트로 다시 쓸 수 있게 된 기술도 사용 가능)
 *
 * Z기술처럼 물리·특수로 번호가 두 번 나오는 기술은 같은 이름이 두 행에 있다.
 * 둘 중 하나라도 사용 가능이면 사용 가능으로 본다.
 */

/** 표의 게임 약칭 → version_group id */
export const GAME_TO_VERSION_GROUP: Record<string, number> = {
  SM: 15,
  USUM: 16,
  PE: 17,
  LGPE: 17,
  SwSh: 18,
  SWSH: 18,
  BDSP: 19,
  LA: 20,
  PLA: 20,
  SV: 21,
  ZA: 22,
  LZA: 22,
};

export const AVAILABILITY_PAGES = [
  { entityKey: 'availability:gen7', title: 'List of moves by availability in Generation VII' },
  { entityKey: 'availability:gen8', title: 'List of moves by availability in Generation VIII' },
  { entityKey: 'availability:gen9', title: 'List of moves by availability in Generation IX' },
] as const;

export type AvailabilityRow = {
  moveNumber: number;
  name: string;
  /** version_group id → 사용 가능 여부 */
  usable: Map<number, boolean>;
};

export type ParsedAvailability = {
  versionGroups: number[];
  rows: Map<number, AvailabilityRow>;
};

/** 머리글 칸 → 게임 약칭. {{gameabbrev7|SM}} → SM, 그 밖에는 마지막 | 뒤 글자 */
const headerGame = (cell: string): string => {
  const abbrev = cell.match(/\{\{gameabbrev\d*\|([^}|]+)/);
  if (abbrev) return abbrev[1].trim();
  const last = cell.split('|').at(-1) ?? '';
  return last.replace(/\{\{[^}]*\}\}|'''|''|\[\[|\]\]/g, '').trim();
};

export const parseAvailabilityTable = (wikitext: string): ParsedAvailability => {
  // 게임 열 머리글: Accuracy 머리글 바로 뒤에 이어지는 ! 줄들
  const lines = wikitext.split('\n');
  const accuracyLine = lines.findIndex((line) => line.startsWith('!') && /Accuracy/.test(line));
  if (accuracyLine < 0) throw new Error('표 머리글에서 Accuracy 열을 찾지 못했습니다');
  const games: string[] = [];
  for (let i = accuracyLine + 1; i < lines.length && lines[i].startsWith('!'); i += 1) {
    games.push(headerGame(lines[i].slice(1).trim()));
  }
  if (games.length === 0) throw new Error('게임 열 머리글이 없습니다');
  const versionGroups = games.map((g) => {
    const vg = GAME_TO_VERSION_GROUP[g];
    if (vg == null) throw new Error(`알 수 없는 게임 열 머리글: ${g} (머리글: ${games.join(', ')})`);
    return vg;
  });

  const rows = new Map<number, AvailabilityRow>();
  const numberByName = new Map<string, number>();
  for (const block of wikitext.split('\n|-')) {
    const cells = block
      .split('\n')
      .filter((line) => line.startsWith('|') && !line.startsWith('|}') && !line.startsWith('|-'))
      .map((line) => line.slice(1).trim());
    const moveNumber = Number(cells[0]);
    const name = cells[1]?.match(/^\{\{m\|([^}|]+)/)?.[1];
    if (!Number.isInteger(moveNumber) || moveNumber <= 0 || !name) continue;

    const gameCells = cells.slice(5);
    if (gameCells.length !== versionGroups.length) {
      throw new Error(
        `${moveNumber} ${name}: 게임 칸 ${gameCells.length}개, 머리글 ${versionGroups.length}개`,
      );
    }
    const usable = new Map<number, boolean>();
    versionGroups.forEach((vg, i) => usable.set(vg, /^\{\{yes\}\}/i.test(gameCells[i])));

    // 같은 이름이 다시 나오면(Z기술 물리·특수) 처음 번호에 합친다
    const firstNumber = numberByName.get(name);
    const existing = firstNumber == null ? undefined : rows.get(firstNumber);
    if (existing) {
      for (const [vg, ok] of usable) if (ok) existing.usable.set(vg, true);
    } else {
      rows.set(moveNumber, { moveNumber, name, usable });
      numberByName.set(name, moveNumber);
    }
  }
  return { versionGroups, rows };
};
