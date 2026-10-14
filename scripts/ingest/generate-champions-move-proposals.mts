/**
 * 최신 Showdown 스냅샷과 현재 DB를 비교해 Champions 기술 변경 제안을 ingest.move_proposal에 쓴다.
 *
 * 만드는 제안
 * - champions_move: 없는 기술 행 추가 / 값이 다른 칸 수정 / Champions에서 빠진 기술 행 삭제
 * - champions_move_property_map: Champions 기준 성질 (전체 세트, base_move_id 기준)
 * - move_change_log (@챔피언스, 버전 그룹 23): Champions 값이 바뀐 기록 (PP 제외)
 *     · 기존 Champions 기술의 값이 바뀌면 직전 Champions 값과 비교하고 업데이트 버전을 붙인다
 *     · 새로 Champions에 들어온 기술은 본편 최신 값(move_current)과 비교한다
 *     · 기록이 필요한 변경이 있으면 --champions-version=<업데이트 버전>이 있어야 실행된다
 *
 * 본편 테이블(move, move_property_map)은 건드리지 않는다. 본편은 본편 값만 담는다.
 *
 * 값을 정하는 규칙 (Champions → SV 폴백)
 * - 기본값은 DB move 행. Showdown Champions 모드가 덮어쓴 칸만 바꾼다.
 * - PP는 Champions 공식: (min(PP, 20) ÷ 5 + 1) × 4. noPPBoosts 기술은 원래 PP 유지.
 *
 * 반영 순서: champions_move insert → champions_move_property_map (외래 키가 base_move_id를 본다)
 *
 * 안전장치
 * - Showdown 파일은 실행하지 않고 TypeScript 구문 트리로만 읽는다.
 * - scripts.ts에서 PP 규칙 코드가 바뀌었으면 제안을 만들지 않고 실패로 끝낸다.
 * - public 스키마는 읽기만 한다 (ingest_bot 권한).
 *
 * 실행:
 *   node --env-file=.env.local scripts/ingest/generate-champions-move-proposals.mts
 *   node --env-file=.env.local scripts/ingest/generate-champions-move-proposals.mts --champions-version=1.1.0
 */
import postgres from 'postgres';
import ts from 'typescript';

import { VG_CHAMPIONS } from './bulbapedia-move-parser.mts';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';

const FILE_BASE_MOVES = 'data/moves.ts';
const FILE_CHAMPIONS_MOVES = 'data/mods/champions/moves.ts';
const FILE_CHAMPIONS_SCRIPTS = 'data/mods/champions/scripts.ts';

// Champions PP 규칙이 이 코드 그대로일 때만 공식을 믿는다
const PP_RULE_PATTERNS = [
  /if \(this\.data\.Moves\[i\]\.pp > 20\)/,
  /this\.modData\('Moves', i\)\.pp = 20;/,
  /return move\.noPPBoosts \? move\.pp : \(move\.pp \/ 5 \+ 1\) \* 4;/,
];

// Showdown flag → move_property.identifier
const FLAG_TO_PROPERTY: Record<string, string> = {
  sound: 'sound',
  punch: 'punching',
  bullet: 'ball-bomb',
  bite: 'biting',
  powder: 'powder',
  pulse: 'pulse',
  dance: 'dance',
  slicing: 'slicing',
  wind: 'wind',
};

// Showdown target → move_target.identifier
const TARGET_TO_IDENTIFIER: Record<string, string> = {
  normal: 'selected-pokemon',
  any: 'selected-pokemon',
  adjacentFoe: 'selected-pokemon',
  self: 'user',
  adjacentAlly: 'ally',
  adjacentAllyOrSelf: 'user-or-ally',
  allAdjacentFoes: 'all-opponents',
  allAdjacent: 'all-other-pokemon',
  all: 'entire-field',
  allySide: 'users-field',
  foeSide: 'opponents-field',
  allies: 'user-and-allies',
  allyTeam: 'user-and-allies',
  randomNormal: 'random-opponent',
  scripted: 'specific-move',
};

// ─── Showdown 데이터 (구문 트리로 읽은 값) ─────────────────────────

export type ShowdownMove = {
  num?: number;
  basePower?: number;
  pp?: number;
  accuracy?: number | true;
  type?: string;
  category?: string;
  priority?: number;
  target?: string;
  isNonstandard?: string | null;
  noPPBoosts?: boolean;
  secondary?: { chance?: number } | null;
  flags?: string[];
};

type Literal = string | number | boolean | null | undefined;

const readLiteral = (node: ts.Expression): Literal => {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (
    ts.isPrefixUnaryExpression(node) &&
    node.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(node.operand)
  ) {
    return -Number(node.operand.text);
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  return undefined;
};

const propertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
};

const readMoveEntry = (obj: ts.ObjectLiteralExpression): ShowdownMove => {
  const entry: ShowdownMove = {};
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = propertyName(prop.name);
    const value = prop.initializer;

    switch (key) {
      case 'num':
      case 'basePower':
      case 'pp':
      case 'priority': {
        const v = readLiteral(value);
        if (typeof v === 'number') entry[key] = v;
        break;
      }
      case 'accuracy': {
        const v = readLiteral(value);
        if (typeof v === 'number' || v === true) entry.accuracy = v;
        break;
      }
      case 'type':
      case 'category':
      case 'target': {
        const v = readLiteral(value);
        if (typeof v === 'string') entry[key] = v;
        break;
      }
      case 'isNonstandard': {
        const v = readLiteral(value);
        if (typeof v === 'string' || v === null) entry.isNonstandard = v;
        break;
      }
      case 'noPPBoosts': {
        entry.noPPBoosts = readLiteral(value) === true;
        break;
      }
      case 'secondary': {
        if (value.kind === ts.SyntaxKind.NullKeyword) {
          entry.secondary = null;
        } else if (ts.isObjectLiteralExpression(value)) {
          const chanceProp = value.properties.find(
            (p): p is ts.PropertyAssignment =>
              ts.isPropertyAssignment(p) && propertyName(p.name) === 'chance',
          );
          const chance = chanceProp ? readLiteral(chanceProp.initializer) : undefined;
          entry.secondary = typeof chance === 'number' ? { chance } : {};
        }
        break;
      }
      case 'flags': {
        if (ts.isObjectLiteralExpression(value)) {
          entry.flags = value.properties
            .filter(ts.isPropertyAssignment)
            .filter((p) => readLiteral(p.initializer) === 1)
            .map((p) => propertyName(p.name))
            .filter((name): name is string => name != null);
        }
        break;
      }
    }
  }
  return entry;
};

/** `export const Moves = { ... }` 형태 파일을 실행하지 않고 읽는다 */
export const parseMoveTable = (source: string): Map<string, ShowdownMove> => {
  const file = ts.createSourceFile('moves.ts', source, ts.ScriptTarget.Latest);
  const table = new Map<string, ShowdownMove>();

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      let init = decl.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) {
        init = init.expression;
      }
      if (!init || !ts.isObjectLiteralExpression(init)) continue;

      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const id = propertyName(prop.name);
        if (id && ts.isObjectLiteralExpression(prop.initializer)) {
          table.set(id, readMoveEntry(prop.initializer));
        }
      }
    }
  }
  return table;
};

export const championsPP = (pp: number, noPPBoosts: boolean): number =>
  noPPBoosts ? pp : (Math.min(pp, 20) / 5 + 1) * 4;

// ─── DB 상태 ─────────────────────────────────────────────────────

export type DbMove = {
  id: number;
  identifier: string;
  move_number: number;
  name_ko: string | null;
  name_en: string | null;
  name_ja: string | null;
  type_id: number;
  damage_class_id: number;
  power: number | null;
  pp: number;
  accuracy: number | null;
  priority: number;
  effect_chance: number | null;
  target_id: number;
  description: string | null;
  is_contact: boolean;
};

export type DbChampionsMove = {
  id: number;
  base_move_id: number;
  power: number | null;
  pp: number | null;
  accuracy: number | null;
  type_id: number | null;
  effect_chance: number | null;
  target_id: number | null;
};

/** 본편 최신 값 (move_current). Champions에 새로 들어온 기술의 이력 비교 기준 */
export type DbMainlineMove = {
  id: number;
  power: number | null;
  accuracy: number | null;
  type_id: number;
  effect_chance: number | null;
};

export type DbState = {
  moves: DbMove[];
  championsMoves: DbChampionsMove[];
  /** 본편 성질 (이력 비교 기준) */
  propertyMap: { move_id: number; property_id: number }[];
  /** Champions 성질 (현재 DB) */
  championsPropertyMap: { base_move_id: number; property_id: number }[];
  mainline: DbMainlineMove[];
  propertyIdByIdentifier: Map<string, number>;
  propertyNameById: Map<number, string>;
  propertySortById: Map<number, number>;
  typeIdByIdentifier: Map<string, number>;
  typeNameById: Map<number, string>;
  targetIdByIdentifier: Map<string, number>;
};

// ─── 제안 ────────────────────────────────────────────────────────

export type Proposal = {
  target_table: 'champions_move' | 'champions_move_property_map' | 'move_change_log';
  op: 'insert' | 'update' | 'delete';
  target_key: Record<string, number | string | null>;
  field: string | null;
  current_value: string | null;
  proposed_value: string | null;
  payload: Record<string, unknown> | null;
  source_values: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'conflict';
  note: string | null;
};

const toText = (v: unknown): string | null => (v == null ? null : String(v));

/** Showdown ID 규칙: 소문자, 영숫자만 */
export const toShowdownId = (identifier: string): string =>
  identifier.toLowerCase().replace(/[^a-z0-9]/g, '');

// 변경 이력 값 표기 (본편 이력과 같은 형식: 값 없음 '—', 추가효과 확률 0은 '—')
const dash = (v: number | null | undefined): string => (v == null || v === 0 ? '—' : String(v));

const groupBy = <K, V>(rows: { key: K; value: V }[]): Map<K, Set<V>> => {
  const map = new Map<K, Set<V>>();
  for (const { key, value } of rows) {
    const set = map.get(key) ?? new Set<V>();
    set.add(value);
    map.set(key, set);
  }
  return map;
};

const sameSet = <T,>(a: Set<T>, b: Set<T>) => a.size === b.size && [...a].every((x) => b.has(x));

export const buildProposals = (
  baseMoves: Map<string, ShowdownMove>,
  championsMoves: Map<string, ShowdownMove>,
  db: DbState,
  championsVersion: string | null = null,
): {
  proposals: Proposal[];
  available: number;
  unmatched: string[];
  /** 업데이트 버전이 없어서 이력을 만들지 못한 기술 */
  logsWithoutVersion: string[];
} => {
  const proposals: Proposal[] = [];
  const unmatched: string[] = [];
  const logsWithoutVersion: string[] = [];
  const moveBySdId = new Map(db.moves.map((m) => [toShowdownId(m.identifier), m]));
  const championsByMoveId = new Map(db.championsMoves.map((c) => [c.base_move_id, c]));
  const mainlineById = new Map(db.mainline.map((m) => [m.id, m]));
  const mainlineProps = groupBy(db.propertyMap.map((r) => ({ key: r.move_id, value: r.property_id })));
  const championsProps = groupBy(
    db.championsPropertyMap.map((r) => ({ key: r.base_move_id, value: r.property_id })),
  );
  const typeName = (id: number | null) => (id == null ? '—' : (db.typeNameById.get(id) ?? '?'));
  const propText = (set: Set<number> | undefined) =>
    set && set.size > 0
      ? [...set]
          .sort((a, b) => (db.propertySortById.get(a) ?? 0) - (db.propertySortById.get(b) ?? 0))
          .map((id) => db.propertyNameById.get(id) ?? '?')
          .join(', ')
      : '—';

  /** Champions 이력 한 건. 업데이트 버전이 필요한데 없으면 기록하지 않고 목록에 남긴다 */
  const pushLog = (
    moveId: number,
    identifier: string,
    field: string,
    oldValue: string,
    newValue: string,
    basis: 'mainline' | 'champions',
  ) => {
    if (oldValue === newValue) return;
    if (!championsVersion) {
      logsWithoutVersion.push(`${identifier} ${field}`);
      return;
    }
    proposals.push({
      target_table: 'move_change_log',
      op: 'insert',
      target_key: { move_id: moveId, version_group_id: VG_CHAMPIONS, field, champions_version: championsVersion },
      field: null,
      current_value: null,
      proposed_value: null,
      payload: {
        move_id: moveId,
        version_group_id: VG_CHAMPIONS,
        field,
        // 성질 이력은 '없음'을 null로 둔다 (기존 기록 형식)
        old_value: field === '성질' && oldValue === '—' ? null : oldValue,
        new_value: newValue,
        champions_version: championsVersion,
      },
      source_values: { basis },
      confidence: 'medium',
      note: `${identifier} ${field} ${oldValue} → ${newValue} (Champions ${championsVersion}, ${basis === 'mainline' ? '본편 최신 값과 비교' : '직전 Champions 값과 비교'})`,
    });
  };

  const availableMoveIds = new Set<number>();

  for (const [sdId, base] of baseMoves) {
    const mod = championsMoves.get(sdId) ?? {};
    const isNonstandard =
      'isNonstandard' in mod ? mod.isNonstandard : base.isNonstandard;
    if (isNonstandard || (base.num ?? 0) <= 0) continue;

    const move = moveBySdId.get(sdId);
    if (!move) {
      unmatched.push(sdId);
      continue;
    }
    if (move.move_number !== base.num) {
      unmatched.push(`${sdId} (번호 ${base.num} ≠ DB ${move.move_number})`);
      continue;
    }
    availableMoveIds.add(move.id);

    const merged: ShowdownMove = { ...base, ...mod };
    const overrides: string[] = [];
    const sourceValues: Record<string, unknown> = { showdown_id: sdId };

    // Champions 값 계산: DB move가 기본, Champions 모드가 덮어쓴 칸만 적용
    // 변화 기술 일부가 move.power = 0으로 저장돼 있어 '위력 없음'(null)으로 정규화한다
    let power = move.power === 0 ? null : move.power;
    if (mod.basePower != null) {
      power = mod.basePower === 0 ? null : mod.basePower;
      overrides.push(`위력 ${move.power ?? '-'}→${power ?? '-'}`);
      sourceValues.basePower = mod.basePower;
    }

    let accuracy = move.accuracy;
    if (mod.accuracy != null) {
      accuracy = mod.accuracy === true ? null : mod.accuracy;
      overrides.push(`명중 ${move.accuracy ?? '-'}→${accuracy ?? '-'}`);
      sourceValues.accuracy = mod.accuracy;
    }

    let typeId = move.type_id;
    if (mod.type != null) {
      const id = db.typeIdByIdentifier.get(mod.type.toLowerCase());
      if (id == null) throw new Error(`알 수 없는 타입: ${mod.type} (${sdId})`);
      if (id !== move.type_id) overrides.push(`타입 → ${mod.type}`);
      typeId = id;
      sourceValues.type = mod.type;
    }

    let effectChance = move.effect_chance;
    if ('secondary' in mod) {
      effectChance = mod.secondary?.chance ?? null;
      overrides.push(`추가효과 확률 ${move.effect_chance ?? '-'}→${effectChance ?? '-'}`);
      sourceValues.secondaryChance = effectChance;
    }

    let targetId = move.target_id;
    let targetConflict: string | null = null;
    if (mod.target != null) {
      const identifier = TARGET_TO_IDENTIFIER[mod.target];
      const id = identifier ? db.targetIdByIdentifier.get(identifier) : undefined;
      if (id == null) {
        targetConflict = `대상 매핑 없음: ${mod.target}`;
      } else {
        targetId = id;
        overrides.push(`대상 → ${identifier}`);
      }
      sourceValues.target = mod.target;
    }

    const basePP = merged.pp ?? move.pp;
    const pp = championsPP(basePP, merged.noPPBoosts === true);
    if (mod.pp != null) {
      overrides.push(`기본 PP ${move.pp}→${mod.pp}`);
      sourceValues.pp = mod.pp;
    }

    const confidence: Proposal['confidence'] = targetConflict
      ? 'conflict'
      : overrides.length > 0
        ? 'medium'
        : 'high';
    const ppNote = merged.noPPBoosts ? `PP ${pp} (공식 예외)` : `PP ${basePP}→${pp} (공식)`;
    const note = [ppNote, ...overrides, targetConflict].filter(Boolean).join(', ');

    const computed = {
      power,
      pp,
      accuracy,
      type_id: typeId,
      effect_chance: effectChance,
      target_id: targetId,
    };

    const existing = championsByMoveId.get(move.id);
    if (!existing) {
      proposals.push({
        target_table: 'champions_move',
        op: 'insert',
        target_key: { base_move_id: move.id },
        field: null,
        current_value: null,
        proposed_value: null,
        payload: {
          base_move_id: move.id,
          identifier: move.identifier,
          name_ko: move.name_ko,
          name_en: move.name_en,
          name_ja: move.name_ja,
          type_id: typeId,
          damage_class_id: move.damage_class_id,
          power,
          pp,
          accuracy,
          priority: move.priority,
          effect_chance: effectChance,
          target_id: targetId,
          description: move.description,
        },
        source_values: sourceValues,
        confidence,
        note,
      });
    } else {
      for (const [field, value] of Object.entries(computed)) {
        const current = existing[field as keyof typeof computed];
        if (current === value) continue;
        proposals.push({
          target_table: 'champions_move',
          op: 'update',
          target_key: { id: existing.id },
          field,
          current_value: toText(current),
          proposed_value: toText(value),
          payload: null,
          source_values: sourceValues,
          confidence,
          note,
        });
      }
    }

    // 성질: Champions 기준 플래그 → champions_move_property_map (본편 move_property_map은 건드리지 않는다)
    const flags = new Set(merged.flags ?? []);
    const flagSource = 'flags' in mod ? 'Champions 모드' : 'Showdown 기본';
    const want = new Set<number>();
    for (const [flag, identifier] of Object.entries(FLAG_TO_PROPERTY)) {
      if (!flags.has(flag)) continue;
      const id = db.propertyIdByIdentifier.get(identifier);
      if (id != null) want.add(id);
    }
    const have = championsProps.get(move.id) ?? new Set<number>();
    for (const propertyId of want) {
      if (have.has(propertyId)) continue;
      proposals.push({
        target_table: 'champions_move_property_map',
        op: 'insert',
        target_key: { base_move_id: move.id, property_id: propertyId },
        field: null,
        current_value: null,
        proposed_value: null,
        payload: { base_move_id: move.id, property_id: propertyId },
        source_values: { showdown_id: sdId, flags: [...flags] },
        confidence: 'high',
        note: `성질 추가 (${flagSource})`,
      });
    }
    for (const propertyId of have) {
      if (want.has(propertyId)) continue;
      proposals.push({
        target_table: 'champions_move_property_map',
        op: 'delete',
        target_key: { base_move_id: move.id, property_id: propertyId },
        field: null,
        current_value: null,
        proposed_value: null,
        payload: null,
        source_values: { showdown_id: sdId, flags: [...flags] },
        confidence: 'high',
        note: `성질 제거 (${flagSource})`,
      });
    }

    // 변경 이력 (PP 제외). 분류·우선도는 Champions 모드 값을 읽지 않으므로 여기서 비교하지 않는다
    if (existing) {
      // 이미 Champions에 있던 기술: 직전 Champions 값 → 새 Champions 값
      pushLog(move.id, move.identifier, '타입', typeName(existing.type_id), typeName(typeId), 'champions');
      pushLog(move.id, move.identifier, '위력', dash(existing.power), dash(power), 'champions');
      pushLog(move.id, move.identifier, '명중', dash(existing.accuracy), dash(accuracy), 'champions');
      pushLog(move.id, move.identifier, '추가효과 확률', dash(existing.effect_chance), dash(effectChance), 'champions');
      if (!sameSet(have, want)) {
        pushLog(move.id, move.identifier, '성질', propText(have), propText(want), 'champions');
      }
    } else {
      // 새로 Champions에 들어온 기술: 본편 최신 값 → Champions 값
      const main = mainlineById.get(move.id);
      if (main) {
        pushLog(move.id, move.identifier, '타입', typeName(main.type_id), typeName(typeId), 'mainline');
        pushLog(move.id, move.identifier, '위력', dash(main.power), dash(power), 'mainline');
        pushLog(move.id, move.identifier, '명중', dash(main.accuracy), dash(accuracy), 'mainline');
        pushLog(move.id, move.identifier, '추가효과 확률', dash(main.effect_chance), dash(effectChance), 'mainline');
      }
      const mainProps = mainlineProps.get(move.id) ?? new Set<number>();
      if (!sameSet(mainProps, want)) {
        pushLog(move.id, move.identifier, '성질', propText(mainProps), propText(want), 'mainline');
      }
    }
  }

  // Champions에서 빠진 기술의 행
  // 매칭에 실패한 기술이 있으면 "없는 기술" 판단을 믿을 수 없으므로 삭제 제안을 만들지 않는다
  if (unmatched.length > 0) {
    return { proposals, available: availableMoveIds.size, unmatched, logsWithoutVersion };
  }
  for (const row of db.championsMoves) {
    if (availableMoveIds.has(row.base_move_id)) continue;
    proposals.push({
      target_table: 'champions_move',
      op: 'delete',
      target_key: { id: row.id },
      field: null,
      current_value: null,
      proposed_value: null,
      payload: null,
      source_values: {},
      confidence: 'medium',
      note: 'Showdown 기준 Champions에서 사용할 수 없는 기술',
    });
  }

  return { proposals, available: availableMoveIds.size, unmatched, logsWithoutVersion };
};

// ─── 실행 ────────────────────────────────────────────────────────

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} 환경 변수가 없습니다 (.env.local 확인)`);
  }
  return value;
};

/** --champions-version=1.1.0 → '1.1.0' */
const parseChampionsVersion = (args: string[]): string | null => {
  const arg = args.find((a) => a.startsWith('--champions-version='));
  if (!arg) return null;
  const value = arg.slice('--champions-version='.length).trim();
  if (!/^[0-9A-Za-z.\-]+$/.test(value)) {
    throw new Error(`업데이트 버전 형식이 올바르지 않습니다: ${value}`);
  }
  return value;
};

const main = async () => {
  const championsVersion = parseChampionsVersion(process.argv.slice(2));
  const sql = postgres({
    host: requireEnv('INGEST_DB_HOST'),
    port: 5432,
    database: 'postgres',
    username: `ingest_bot.${PROJECT_REF}`,
    password: requireEnv('INGEST_DB_PASSWORD'),
    ssl: 'require',
    max: 1,
    prepare: false,
  });

  const [run] = await sql<{ id: number }[]>`
    insert into ingest.run (source, scope)
    values ('generator', ${championsVersion ? `champions-move ${championsVersion}` : 'champions-move'})
    returning id
  `;
  const runId = run.id;
  const stats: Record<string, unknown> = {};

  try {
    const snapshots = await sql<{ id: number; page_key: string; content: string }[]>`
      select distinct on (page_key) id, page_key, content
      from ingest.snapshot
      where source = 'showdown'
        and page_key in (${FILE_BASE_MOVES}, ${FILE_CHAMPIONS_MOVES}, ${FILE_CHAMPIONS_SCRIPTS})
      order by page_key, fetched_at desc
    `;
    const byPath = new Map(snapshots.map((s) => [s.page_key, s]));
    const baseSnap = byPath.get(FILE_BASE_MOVES);
    const champSnap = byPath.get(FILE_CHAMPIONS_MOVES);
    const scriptSnap = byPath.get(FILE_CHAMPIONS_SCRIPTS);
    if (!baseSnap || !champSnap || !scriptSnap) {
      throw new Error('Showdown 스냅샷이 없습니다. fetch-showdown-snapshot을 먼저 실행하세요');
    }
    stats.snapshotIds = { base: baseSnap.id, champions: champSnap.id, scripts: scriptSnap.id };

    const brokenRule = PP_RULE_PATTERNS.find((p) => !p.test(scriptSnap.content));
    if (brokenRule) {
      throw new Error(
        `Champions PP 규칙 코드가 바뀌었습니다 (${brokenRule}). 공식을 확인하기 전에는 제안을 만들지 않습니다`,
      );
    }

    // bigint 칸은 postgres 라이브러리가 문자열로 돌려준다. 숫자 비교(===)가 깨지지 않게
    // 조회할 때 ::int로 바꾼다 (모두 int 범위 안의 값)
    const [moves, championsMoves, propertyMap, championsPropertyMap, mainline, properties, types, targets] =
      await Promise.all([
        sql<DbMove[]>`
          select id::int, identifier, move_number::int, name_ko, name_en, name_ja,
                 type_id::int, damage_class_id::int, power, pp, accuracy, priority,
                 effect_chance, target_id::int, description, is_contact
          from public.move
        `,
        sql<DbChampionsMove[]>`
          select id::int, base_move_id::int, power, pp, accuracy, type_id::int,
                 effect_chance, target_id::int
          from public.champions_move
        `,
        sql<{ move_id: number; property_id: number }[]>`
          select move_id::int, property_id::int from public.move_property_map
        `,
        sql<{ base_move_id: number; property_id: number }[]>`
          select base_move_id::int, property_id::int from public.champions_move_property_map
        `,
        // 본편 최신 값. 위력 0은 '위력 없음'으로 맞춘다
        sql<DbMainlineMove[]>`
          select id::int, nullif(power, 0) as power, accuracy, type_id::int, effect_chance
          from public.move_current
        `,
        sql<{ id: number; identifier: string; name_ko: string; sort_order: number }[]>`
          select id::int, identifier, name_ko, sort_order::int from public.move_property
        `,
        sql<{ id: number; identifier: string; name_ko: string }[]>`
          select id::int, identifier, name_ko from public.type
        `,
        sql<{ id: number; identifier: string }[]>`
          select id::int, identifier from public.move_target
        `,
      ]);

    const { proposals, available, unmatched, logsWithoutVersion } = buildProposals(
      parseMoveTable(baseSnap.content),
      parseMoveTable(champSnap.content),
      {
        moves,
        championsMoves,
        propertyMap,
        championsPropertyMap,
        mainline,
        propertyIdByIdentifier: new Map(properties.map((p) => [p.identifier, p.id])),
        propertyNameById: new Map(properties.map((p) => [p.id, p.name_ko])),
        propertySortById: new Map(properties.map((p) => [p.id, p.sort_order])),
        typeIdByIdentifier: new Map(types.map((t) => [t.identifier, t.id])),
        typeNameById: new Map(types.map((t) => [t.id, t.name_ko])),
        targetIdByIdentifier: new Map(targets.map((t) => [t.identifier, t.id])),
      },
      championsVersion,
    );

    // 변경 이력이 필요한데 업데이트 버전이 없으면 아무것도 넣지 않는다 (이력 없는 값 변경을 막기 위해)
    if (logsWithoutVersion.length > 0) {
      stats.logsWithoutVersion = logsWithoutVersion;
      throw new Error(
        `Champions 값이 바뀐 기술이 ${logsWithoutVersion.length}건 있습니다. ` +
          '--champions-version=<업데이트 버전>을 지정해 다시 실행하세요',
      );
    }

    // 한 번의 쿼리로 넣는다. 같은 대상에 pending 제안이 이미 있으면 건너뛴다
    // 주의: 문자열(JSON.stringify)을 넘기면 postgres 라이브러리가 jsonb 파라미터로 한 번 더 감싸서
    // "문자열 하나"가 된다. 배열 그대로 sql.json()으로 넘겨야 한다
    const inserted =
      proposals.length === 0
        ? []
        : await sql<{ id: number }[]>`
            insert into ingest.move_proposal
              (run_id, target_table, op, target_key, field, current_value,
               proposed_value, payload, source_values, confidence, note)
            select ${runId}, r.target_table, r.op, r.target_key, r.field, r.current_value,
                   r.proposed_value, r.payload, r.source_values, r.confidence, r.note
            from jsonb_to_recordset(${sql.json(proposals as unknown as postgres.JSONValue)}::jsonb) as r(
              target_table text, op text, target_key jsonb, field text,
              current_value text, proposed_value text, payload jsonb,
              source_values jsonb, confidence text, note text)
            -- 같은 대상·같은 값으로 이미 거절된 제안은 다시 만들지 않는다 (값이 바뀌면 새로 올라온다)
            where not exists (
              select 1 from ingest.move_proposal x
              where x.status = 'rejected'
                and x.target_table = r.target_table and x.op = r.op and x.target_key = r.target_key
                and coalesce(x.field, '') = coalesce(r.field, '')
                and x.proposed_value is not distinct from r.proposed_value
                and x.payload is not distinct from r.payload
            )
            on conflict (target_table, op, target_key, (coalesce(field, '')))
              where status = 'pending'
            do nothing
            returning id
          `;

    const count = (table: string, op: string) =>
      proposals.filter((p) => p.target_table === table && p.op === op).length;
    Object.assign(stats, {
      available,
      unmatched,
      proposals: proposals.length,
      inserted: inserted.length,
      skippedAsDuplicate: proposals.length - inserted.length,
      byKind: {
        'champions_move insert': count('champions_move', 'insert'),
        'champions_move update': count('champions_move', 'update'),
        'champions_move delete': count('champions_move', 'delete'),
        'champions_move_property_map insert': count('champions_move_property_map', 'insert'),
        'champions_move_property_map delete': count('champions_move_property_map', 'delete'),
        'move_change_log insert': count('move_change_log', 'insert'),
      },
      byConfidence: {
        high: proposals.filter((p) => p.confidence === 'high').length,
        medium: proposals.filter((p) => p.confidence === 'medium').length,
        conflict: proposals.filter((p) => p.confidence === 'conflict').length,
      },
    });

    const status = unmatched.length > 0 ? 'partial' : 'success';
    await sql`
      update ingest.run
      set status = ${status}, finished_at = now(), stats = ${sql.json(stats as postgres.JSONValue)}
      where id = ${runId}
    `;
    console.log(`[run ${runId}] ${status}`, JSON.stringify(stats, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update ingest.run
      set status = 'failed', finished_at = now(),
          stats = ${sql.json(stats as postgres.JSONValue)}, error = ${message}
      where id = ${runId}
    `;
    console.error(`[run ${runId}] failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
};

// 테스트에서 import할 때는 실행하지 않는다
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
