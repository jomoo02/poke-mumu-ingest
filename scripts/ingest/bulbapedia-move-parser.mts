/**
 * Bulbapedia 기술 문서(wikitext) 해석. DB에 접근하지 않는 순수 함수만 둔다.
 *
 * - {{MoveInfobox}}: 현재 값과 {{tt|현재|과거 설명}} 툴팁
 * - {{LegendsZAMove}}: ZA 수치
 * - 툴팁 설명("65 in Generation I", "85 prior to Generation V; 90 prior to Champions" 등)을
 *   버전 그룹별 값으로 푼다. 해석할 수 없는 표현은 null을 돌려준다(추측하지 않는다).
 */

// ─── 버전 그룹 ───────────────────────────────────────────────────

export type VersionGroup = { id: number; generation: number; sort_order: number };

export const VG_LGPE = 17;
export const VG_LEGENDS_ARCEUS = 20;
export const VG_SCARLET_VIOLET = 21;
export const VG_LEGENDS_ZA = 22;
export const VG_CHAMPIONS = 23;

// version_move와 비교하는 본가 버전 그룹 (LA·ZA·Champions는 별도 테이블)
export const isMainline = (vg: VersionGroup) =>
  vg.id !== VG_LEGENDS_ARCEUS && vg.id !== VG_LEGENDS_ZA && vg.id !== VG_CHAMPIONS;

const ROMAN: Record<string, number> = {
  I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9,
};

// ─── 템플릿 ──────────────────────────────────────────────────────

/** `{{Name\n|key=value\n...\n}}` 의 파라미터. 값 안의 {{...}}는 그대로 둔다 */
export const parseTemplate = (content: string, name: string): Map<string, string> | null => {
  const start = content.indexOf(`{{${name}`);
  if (start < 0) return null;

  // 중첩된 {{ }}를 세어 템플릿 끝을 찾는다
  let depth = 0;
  let end = -1;
  for (let i = start; i < content.length - 1; i += 1) {
    if (content[i] === '{' && content[i + 1] === '{') {
      depth += 1;
      i += 1;
    } else if (content[i] === '}' && content[i + 1] === '}') {
      depth -= 1;
      i += 1;
      if (depth === 0) {
        end = i - 1;
        break;
      }
    }
  }
  if (end < 0) return null;

  const body = content.slice(start + 2 + name.length, end);
  const params = new Map<string, string>();
  // 최상위 '|'로만 나눈다
  let level = 0;
  let current = '';
  const parts: string[] = [];
  for (let i = 0; i < body.length; i += 1) {
    const two = body.slice(i, i + 2);
    if (two === '{{' || two === '[[') {
      level += 1;
      current += two;
      i += 1;
    } else if (two === '}}' || two === ']]') {
      level -= 1;
      current += two;
      i += 1;
    } else if (body[i] === '|' && level === 0) {
      parts.push(current);
      current = '';
    } else {
      current += body[i];
    }
  }
  parts.push(current);

  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    params.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  return params;
};

/** 값 정리: HTML 주석·엔티티 제거 */
const clean = (raw: string): string =>
  raw
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .trim();

export type FieldValue = { current: string; history: string | null };

/** `{{tt|90|65 in Generation I}}` → { current: '90', history: '65 in Generation I' } */
export const parseFieldValue = (raw: string | undefined): FieldValue | null => {
  if (raw == null) return null;
  const value = clean(raw);
  const tt = value.match(/^\{\{tt\|([^|}]*)\|([\s\S]*)\}\}$/);
  if (tt) return { current: tt[1].trim(), history: clean(tt[2]) };
  // 각주형 툴팁(예: 80{{tt|*|설명}})은 과거 값이 아니므로 무시
  return { current: value.replace(/\{\{tt\|\*\|[\s\S]*?\}\}/g, '').trim(), history: null };
};

/**
 * 수치 문자열 → 숫자. 값이 없음을 뜻하는 표현(—, 빈 값)은 null.
 * 해석할 수 없으면 undefined (비교하지 않는다).
 */
export const parseNumber = (value: string): number | null | undefined => {
  const v = value.replace(/−/g, '-').trim();
  if (v === '' || v === '—' || v === '-' || v === '--') return null;
  const m = v.match(/^([+-]?\d+)%?$/);
  return m ? Number(m[1]) : undefined;
};

// ─── 툴팁 설명 해석 ───────────────────────────────────────────────

export type HistorySegment = {
  value: number | null;
  /** 이 값이 적용되는 버전 그룹 */
  vgIds: number[];
  /** "prior to Champions": 본가 전체의 기준값이 된다 */
  priorToChampions: boolean;
};

const gen = (roman: string): number | undefined => ROMAN[roman.toUpperCase()];

/** 범위 표현 하나 → 버전 그룹 목록. 모르는 표현이면 null */
const parseScope = (scope: string, vgs: VersionGroup[]): { vgIds: number[]; priorToChampions: boolean } | null => {
  const s = scope.trim().replace(/\s+/g, ' ').replace(/^(?!in |prior to )/, 'in ');
  const ids = (pred: (vg: VersionGroup) => boolean) => vgs.filter(pred).map((vg) => vg.id);
  let m: RegExpMatchArray | null;

  if (/^prior to (Pokémon )?Champions$/i.test(s)) {
    return { vgIds: ids((vg) => vg.id < VG_CHAMPIONS), priorToChampions: true };
  }
  if ((m = s.match(/^prior to Generation ([IVX]+)$/i))) {
    const g = gen(m[1]);
    return g ? { vgIds: ids((vg) => vg.generation < g), priorToChampions: false } : null;
  }
  if ((m = s.match(/^in Generations? ([IVX]+) ?(?:-|–|to) ?([IVX]+)$/i))) {
    const a = gen(m[1]);
    const b = gen(m[2]);
    return a && b ? { vgIds: ids((vg) => vg.generation >= a && vg.generation <= b), priorToChampions: false } : null;
  }
  if ((m = s.match(/^in Generation ([IVX]+)$/i))) {
    const g = gen(m[1]);
    return g ? { vgIds: ids((vg) => vg.generation === g), priorToChampions: false } : null;
  }
  if (/^in (LGPE|Pokémon: Let's Go, Pikachu! and Let's Go, Eevee!)$/i.test(s)) {
    return { vgIds: [VG_LGPE], priorToChampions: false };
  }
  if (/^prior to (LGPE|Pokémon: Let's Go, Pikachu! and Let's Go, Eevee!)$/i.test(s)) {
    const lgpe = vgs.find((vg) => vg.id === VG_LGPE);
    return lgpe ? { vgIds: ids((vg) => vg.sort_order < lgpe.sort_order), priorToChampions: false } : null;
  }
  if (/^in (Pokémon )?Legends: Arceus$|^in P:LA$/i.test(s)) {
    return { vgIds: [VG_LEGENDS_ARCEUS], priorToChampions: false };
  }
  if (/^in Scarlet (and|&) Violet$/i.test(s)) {
    return { vgIds: [VG_SCARLET_VIOLET], priorToChampions: false };
  }
  return null;
};

/**
 * 툴팁 설명 전체 → 구간 목록. 한 구간이라도 해석하지 못하면 null.
 * 예: "85 prior to Generation V; 90 prior to Pokémon Champions"
 *     "70 in Generations I-IV, 80 in Generation V"
 *     "65 prior to Generation IV and in Legends: Arceus"
 */
export const parseHistory = (note: string, vgs: VersionGroup[]): HistorySegment[] | null => {
  const pieces = note
    .replace(/−/g, '-')
    // Bulbapedia 표기 흔들림: "10 in prior to Generation V"
    .replace(/\bin prior to\b/gi, 'prior to')
    .split(/;\s*|,\s*(?=[+-]?\d|—)/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (pieces.length === 0) return null;

  const segments: HistorySegment[] = [];
  for (const piece of pieces) {
    const m = piece.match(/^([+-]?\d+%?|—)\s+(.+)$/);
    if (!m) return null;
    const value = parseNumber(m[1]);
    if (value === undefined) return null;

    const vgIds = new Set<number>();
    let priorToChampions = false;
    for (const scope of m[2].split(/\s+and\s+(?=in |prior to |LGPE|Legends|P:LA)/i)) {
      const parsed = parseScope(scope, vgs);
      if (!parsed) return null;
      parsed.vgIds.forEach((id) => vgIds.add(id));
      priorToChampions ||= parsed.priorToChampions;
    }
    segments.push({ value, vgIds: [...vgIds], priorToChampions });
  }
  return segments;
};

/**
 * 버전 그룹별 기대값.
 * - 기준값: "prior to Champions" 값이 있으면 그것, 없으면 현재 값
 * - 나머지 구간은 넓은 구간부터 적용해서 좁은 구간이 이기게 한다
 * 반환: vgId → 값, 그리고 그 값이 툴팁에 명시된 것인지(explicit)
 */
export const expectedByVersionGroup = (
  current: number | null,
  segments: HistorySegment[],
  vgs: VersionGroup[],
): Map<number, { value: number | null; explicit: boolean }> => {
  const champions = segments.find((s) => s.priorToChampions);
  const base = champions ? champions.value : current;
  const result = new Map<number, { value: number | null; explicit: boolean }>();
  for (const vg of vgs) result.set(vg.id, { value: base, explicit: false });

  const others = segments
    .filter((s) => !s.priorToChampions)
    .sort((a, b) => b.vgIds.length - a.vgIds.length);
  for (const s of others) {
    for (const id of s.vgIds) result.set(id, { value: s.value, explicit: true });
  }
  return result;
};

// ─── 인포박스 ────────────────────────────────────────────────────

export type ParsedMove = {
  type: string | null;
  category: string | null;
  contact: boolean | null;
  fields: {
    power?: FieldValue;
    accuracy?: FieldValue;
    pp?: FieldValue;
    priority?: FieldValue;
  };
};

export const parseInfobox = (content: string): ParsedMove | null => {
  const box = parseTemplate(content, 'MoveInfobox');
  if (!box) return null;

  const lower = (key: string) => {
    const v = box.get(key);
    return v ? clean(v).toLowerCase() || null : null;
  };
  const touches = lower('touches');

  const fields: ParsedMove['fields'] = {};
  const power = parseFieldValue(box.get('power'));
  const accuracy = parseFieldValue(box.get('accuracy'));
  const pp = parseFieldValue(box.get('basepp'));
  const priority = parseFieldValue(box.get('priority'));
  if (power) fields.power = power;
  if (accuracy) fields.accuracy = accuracy;
  if (pp) fields.pp = pp;
  if (priority) fields.priority = priority;

  return {
    type: lower('type'),
    category: lower('damagecategory'),
    contact: touches === 'yes' ? true : touches === 'no' ? false : null,
    fields,
  };
};

// ─── ZA ──────────────────────────────────────────────────────────

export type ParsedZa = {
  type: string | null;
  category: string | null;
  base: { power?: number | null; cooldown?: number | null; windUp?: number | null; duration?: number | null };
  plus: { power?: number | null; cooldown?: number | null; windUp?: number | null; duration?: number | null };
};

export const parseLegendsZa = (content: string): ParsedZa | null => {
  const za = parseTemplate(content, 'LegendsZAMove');
  if (!za) return null;

  const num = (key: string) => {
    const raw = za.get(key);
    if (raw == null) return undefined;
    const v = parseNumber(clean(raw));
    return v === undefined ? undefined : v;
  };
  const pick = (entries: [string, number | null | undefined][]) =>
    Object.fromEntries(entries.filter(([, v]) => v !== undefined));

  return {
    type: za.get('type') ? clean(za.get('type') ?? '').toLowerCase() : null,
    category: za.get('damagecategory') ? clean(za.get('damagecategory') ?? '').toLowerCase() : null,
    base: pick([
      ['power', num('power')],
      ['cooldown', num('cooldown')],
      ['windUp', num('charge-time')],
      ['duration', num('effect-duration')],
    ]),
    plus: pick([
      ['power', num('power-plus')],
      ['cooldown', num('cooldown-plus')],
      ['windUp', num('charge-time-plus')],
      ['duration', num('effect-duration-plus')],
    ]),
  };
};

// ─── 3세대 이전 분류 규칙 ─────────────────────────────────────────

// 물리/특수 분리(4세대) 전에는 타입으로 분류가 정해진다
const PHYSICAL_TYPES_BEFORE_GEN4 = new Set([
  'normal', 'fighting', 'flying', 'poison', 'ground', 'rock', 'bug', 'ghost', 'steel',
]);

export const categoryBeforeGen4 = (typeIdentifier: string): 'physical' | 'special' | null => {
  if (typeIdentifier === 'unknown') return null;
  return PHYSICAL_TYPES_BEFORE_GEN4.has(typeIdentifier) ? 'physical' : 'special';
};
