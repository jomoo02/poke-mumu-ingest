/**
 * Bulbapedia 기술 원문(ingest.snapshot)과 DB를 비교해 제안을 ingest.move_proposal에 쓴다.
 * 두 단계로 나눠 실행한다. 변경 이력은 버전별 값이 바로잡힌 뒤에 만들어야 정확하기 때문이다.
 *
 *   --phase=values   (먼저)
 *     A. move           현재 값 (위력·명중·PP·우선도·타입·분류·접촉)
 *     B. version_move   툴팁에 명시된 과거 세대 값, 최신 본가 버전의 현재 값
 *     D. version_move_legends_za  ZA 템플릿 값
 *     (Champions 값·이력은 generate-champions-move-proposals가 만든다)
 *
 *   --phase=history  (values 제안을 반영한 뒤)
 *     C. move_change_log  version_move 버전 간 변화 중 기록에 없는 것
 *
 * 비교 규칙 (902개 실제 원문으로 검증)
 * - 툴팁이 없는 과거 세대에는 현재 값을 퍼뜨리지 않는다 (인포박스 툴팁이 불완전한 기술이 있음)
 * - Bulbapedia 값이 Champions 값과 같으면 Champions 값을 보여주는 것으로 본다 (move는 SV 기준)
 * - Bulbapedia 값이 이 기술의 다른 버전 행 값과 같으면 그 버전을 보여주는 것으로 본다 (파트너 기술)
 * - 레츠고 행은 레츠고를 명시한 툴팁이 있을 때만 비교한다
 * - 사용 불가(is_usable=false) 행은 건드리지 않는다
 * - 본편 버전만 비교한다. 레전드 아르세우스·레전드 Z-A·챔피언스는 각자 테이블에서 다룬다
 * - move는 본편 최신 값이다. Bulbapedia 인포박스가 Champions 값을 보여주면 move를 바꾸지 않는다
 * - 해석할 수 없는 툴팁은 추측하지 않고 건너뛴 뒤 기록한다
 *
 * 실행:
 *   node --env-file=.env.local scripts/ingest/generate-bulbapedia-move-proposals.mts --phase=values
 *   node --env-file=.env.local scripts/ingest/generate-bulbapedia-move-proposals.mts --phase=history
 */
import postgres from 'postgres';

import {
  categoryBeforeGen4,
  expectedByVersionGroup,
  isMainline,
  parseHistory,
  parseInfobox,
  parseLegendsZa,
  parseNumber,
  VG_CHAMPIONS,
  VG_LEGENDS_ARCEUS,
  VG_LEGENDS_ZA,
  VG_LGPE,
  type HistorySegment,
  type ParsedMove,
  type ParsedZa,
  type VersionGroup,
} from './bulbapedia-move-parser.mts';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';
const INSERT_BATCH_SIZE = 2000;

/** version_move에서 비교하는 본편 버전 그룹 (레전드 아르세우스·레전드 Z-A·챔피언스 제외) */
const MAINLINE_VG = (vg: number) =>
  vg !== VG_LEGENDS_ARCEUS && vg !== VG_LEGENDS_ZA && vg !== VG_CHAMPIONS;

// ─── DB 상태 ─────────────────────────────────────────────────────

export type DbMove = {
  id: number;
  identifier: string;
  power: number | null;
  pp: number;
  accuracy: number | null;
  priority: number;
  type_id: number;
  damage_class_id: number;
  is_contact: boolean;
};

export type DbVersionMove = {
  id: number;
  move_id: number;
  vg: number;
  power: number | null;
  pp: number | null;
  accuracy: number | null;
  priority: number | null;
  type_id: number;
  damage_class_id: number | null;
  effect_chance: number | null;
  is_usable: boolean | null;
};

export type DbZa = {
  id: number;
  base_move_id: number;
  variant: string;
  power: number | null;
  cooldown: number | null;
  type_id: number;
  damage_class_id: number;
  frames_wind_up: number | null;
  duration: number | null;
};

export type DbState = {
  moves: DbMove[];
  vm: DbVersionMove[];
  champ: { base_move_id: number; power: number | null; accuracy: number | null; type_id: number | null }[];
  za: DbZa[];
  types: { id: number; identifier: string; name_ko: string }[];
  dcs: { id: number; identifier: string; name_ko: string }[];
  vgs: VersionGroup[];
  log: { move_id: number; vg: number; field: string; old: string | null; new: string | null }[];
};

// ─── 제안 ────────────────────────────────────────────────────────

export type Proposal = {
  target_table: 'move' | 'version_move' | 'version_move_legends_za' | 'move_change_log';
  op: 'insert' | 'update';
  target_key: Record<string, string | number>;
  field: string | null;
  current_value: string | null;
  proposed_value: string | null;
  payload: Record<string, string | number | null> | null;
  source_values: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'conflict';
  note: string;
};

const text = (v: number | boolean | string | null | undefined): string | null =>
  v == null ? null : String(v);

// 변화 기술 일부가 위력 0으로 저장돼 있어 '없음'과 같게 본다
const sameValue = (field: string, a: number | null, b: number | null) => {
  const n = (v: number | null) => (field === 'power' && v === 0 ? null : v);
  return n(a) === n(b);
};

const NUMERIC_FIELDS = [
  { key: 'power', col: 'power', label: '위력' },
  { key: 'accuracy', col: 'accuracy', label: '명중' },
  { key: 'pp', col: 'pp', label: 'PP' },
  { key: 'priority', col: 'priority', label: '우선도' },
] as const;

export type ParsedSnapshot = {
  moveId: number;
  pageKey: string;
  infobox: ParsedMove | null;
  za: ParsedZa | null;
};

export type ValuesResult = {
  proposals: Proposal[];
  unparsedNotes: string[];
  skipped: Record<string, number>;
};

// ─── values 단계 ─────────────────────────────────────────────────

export const buildValueProposals = (snapshots: ParsedSnapshot[], db: DbState): ValuesResult => {
  const proposals: Proposal[] = [];
  const unparsedNotes: string[] = [];
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };

  const moveById = new Map(db.moves.map((m) => [m.id, m]));
  const champByMove = new Map(db.champ.map((c) => [c.base_move_id, c]));
  const typeById = new Map(db.types.map((t) => [t.id, t]));
  const typeByIdentifier = new Map(db.types.map((t) => [t.identifier, t]));
  const dcById = new Map(db.dcs.map((d) => [d.id, d]));
  const dcByIdentifier = new Map(db.dcs.map((d) => [d.identifier, d]));
  const vgById = new Map(db.vgs.map((vg) => [vg.id, vg]));
  const mainline = db.vgs.filter(isMainline);
  const vmByMove = new Map<number, DbVersionMove[]>();
  for (const row of db.vm) {
    if (!MAINLINE_VG(row.vg)) continue;
    const list = vmByMove.get(row.move_id) ?? [];
    list.push(row);
    vmByMove.set(row.move_id, list);
  }
  for (const list of vmByMove.values()) {
    list.sort((a, b) => (vgById.get(a.vg)?.sort_order ?? 0) - (vgById.get(b.vg)?.sort_order ?? 0));
  }
  const zaByMove = new Map<number, DbZa[]>();
  for (const row of db.za) {
    const list = zaByMove.get(row.base_move_id) ?? [];
    list.push(row);
    zaByMove.set(row.base_move_id, list);
  }

  for (const snap of snapshots) {
    const move = moveById.get(snap.moveId);
    const box = snap.infobox;
    if (!move || !box) {
      skip('인포박스 없음');
      continue;
    }
    const rows = vmByMove.get(move.id) ?? [];
    const usableRows = rows.filter((r) => r.is_usable !== false);
    const latest = usableRows.at(-1);
    const champ = champByMove.get(move.id);
    const source = { page: snap.pageKey };

    for (const { key, col, label } of NUMERIC_FIELDS) {
      const fv = box.fields[key];
      if (!fv) continue;
      const current = parseNumber(fv.current);
      if (current === undefined) {
        skip(`${label}: 숫자가 아님`);
        continue;
      }
      let segments: HistorySegment[] = [];
      if (fv.history) {
        const parsed = parseHistory(fv.history, db.vgs);
        if (!parsed) {
          unparsedNotes.push(`${move.identifier}.${key}: ${fv.history}`);
          continue;
        }
        segments = parsed;
      }
      const championsSegment = segments.find((s) => s.priorToChampions);
      const mainValue = championsSegment ? championsSegment.value : current;

      // Z기술·다이맥스 기술처럼 PP 개념이 없는 기술
      if (key === 'pp' && mainValue === null) {
        skip('PP 없음(Z·다이맥스)');
        continue;
      }

      // Bulbapedia 값이 무엇을 보여주는지 판단
      const showsChampions =
        !championsSegment &&
        champ != null &&
        (key === 'power' || key === 'accuracy') &&
        sameValue(key, mainValue, champ[key]);
      const showsOtherVersion =
        latest != null &&
        sameValue(key, move[col], latest[col]) &&
        rows.some((r) => r !== latest && sameValue(key, mainValue, r[col]));

      // A. move
      if (!sameValue(key, mainValue, move[col])) {
        if (showsChampions) skip(`${label}: Champions 값 표시`);
        else if (showsOtherVersion) skip(`${label}: 다른 버전 값 표시`);
        else {
          proposals.push({
            target_table: 'move',
            op: 'update',
            target_key: { id: move.id },
            field: col,
            current_value: text(move[col]),
            proposed_value: text(mainValue),
            payload: null,
            source_values: { ...source, bulbapedia: fv.current, tooltip: fv.history },
            confidence: 'medium',
            note: `${label} (Bulbapedia 인포박스)`,
          });
        }
      }

      // B. version_move
      const explicit = new Map<number, number | null>();
      if (segments.length > 0) {
        const expected = expectedByVersionGroup(current, segments, mainline);
        for (const [vgId, e] of expected) if (e.explicit) explicit.set(vgId, e.value);
      }
      const lgpeNamed = segments.some((s) => s.vgIds.length === 1 && s.vgIds[0] === VG_LGPE);

      for (const row of usableRows) {
        let expectedValue: number | null;
        let fromTooltip: boolean;
        if (row.vg === VG_LGPE && !lgpeNamed) continue;
        if (explicit.has(row.vg)) {
          expectedValue = explicit.get(row.vg) ?? null;
          fromTooltip = true;
        } else if (row === latest) {
          if (showsChampions || showsOtherVersion) continue;
          expectedValue = mainValue;
          fromTooltip = false;
        } else {
          continue;
        }
        if (sameValue(key, expectedValue, row[col])) continue;

        const vgName = vgById.get(row.vg);
        proposals.push({
          target_table: 'version_move',
          op: 'update',
          target_key: { id: row.id },
          field: col,
          current_value: text(row[col]),
          proposed_value: text(expectedValue),
          payload: null,
          source_values: {
            ...source,
            move_id: move.id,
            version_group_id: row.vg,
            bulbapedia: fv.current,
            tooltip: fv.history,
          },
          confidence: fromTooltip ? 'high' : 'medium',
          note: `${move.identifier} ${label} @${vgName?.id} (${fromTooltip ? '툴팁 명시' : '최신 버전 현재 값'})`,
        });
      }
    }

    // A. 타입 (move는 본편 값. 인포박스가 Champions 타입을 보여주면 건드리지 않는다)
    if (box.type) {
      const bulbaType = typeByIdentifier.get(box.type);
      if (!bulbaType) skip('타입: 알 수 없는 값');
      else if (bulbaType.id !== move.type_id) {
        const champType = champ?.type_id ?? null;
        const oldType = typeById.get(move.type_id);
        if (champType === bulbaType.id) skip('타입: Champions 값 표시');
        else {
          proposals.push({
            target_table: 'move',
            op: 'update',
            target_key: { id: move.id },
            field: 'type_id',
            current_value: text(move.type_id),
            proposed_value: text(bulbaType.id),
            payload: null,
            source_values: { ...source, bulbapedia: box.type, champions_type_id: champType },
            confidence: 'conflict',
            note: `타입 ${oldType?.name_ko} → ${bulbaType.name_ko} (본편 값과 다름, 확인 필요)`,
          });
        }
      }
    }

    // A. 분류
    if (box.category && box.category !== 'varies') {
      const dc = dcByIdentifier.get(box.category);
      if (!dc) skip('분류: 알 수 없는 값');
      else if (dc.id !== move.damage_class_id) {
        proposals.push({
          target_table: 'move',
          op: 'update',
          target_key: { id: move.id },
          field: 'damage_class_id',
          current_value: text(move.damage_class_id),
          proposed_value: text(dc.id),
          payload: null,
          source_values: { ...source, bulbapedia: box.category },
          confidence: 'conflict',
          note: `분류 ${dcById.get(move.damage_class_id)?.name_ko} → ${dc.name_ko} (확인 필요)`,
        });
      }
    }

    // A. 접촉
    if (box.contact != null && box.contact !== move.is_contact) {
      proposals.push({
        target_table: 'move',
        op: 'update',
        target_key: { id: move.id },
        field: 'is_contact',
        current_value: text(move.is_contact),
        proposed_value: text(box.contact),
        payload: null,
        source_values: source,
        confidence: 'medium',
        note: '접촉 여부 (Bulbapedia 인포박스)',
      });
    }

    // E. 4세대 이전 분류 규칙 (타입으로 결정)
    for (const row of usableRows) {
      const generation = vgById.get(row.vg)?.generation ?? 99;
      if (generation >= 4 || row.damage_class_id == null) continue;
      const dc = dcById.get(row.damage_class_id);
      if (!dc || dc.identifier === 'status') continue;
      const want = categoryBeforeGen4(typeById.get(row.type_id)?.identifier ?? 'unknown');
      const wantDc = want ? dcByIdentifier.get(want) : undefined;
      if (wantDc && wantDc.id !== row.damage_class_id) {
        proposals.push({
          target_table: 'version_move',
          op: 'update',
          target_key: { id: row.id },
          field: 'damage_class_id',
          current_value: text(row.damage_class_id),
          proposed_value: text(wantDc.id),
          payload: null,
          source_values: { move_id: move.id, version_group_id: row.vg, rule: 'type-based category before Gen IV' },
          confidence: 'high',
          note: `${move.identifier} 분류 @${row.vg} (4세대 이전은 타입으로 결정)`,
        });
      }
    }

    // D. ZA
    if (snap.za) {
      const zaRows = zaByMove.get(move.id) ?? [];
      const base = zaRows.find((r) => r.variant === 'base');
      const plus = zaRows.find((r) => r.variant === 'plus');
      if (!base) {
        skip('ZA: DB 행 없음');
      } else {
        const za = snap.za;
        const zaType = za.type ? typeByIdentifier.get(za.type) : undefined;
        if (zaType && zaType.id !== base.type_id) {
          proposals.push({
            target_table: 'version_move_legends_za',
            op: 'update',
            target_key: { id: base.id },
            field: 'type_id',
            current_value: text(base.type_id),
            proposed_value: text(zaType.id),
            payload: null,
            source_values: { ...source, bulbapedia: za.type },
            confidence: 'conflict',
            note: `${move.identifier} ZA 타입 (타입 변경은 move·이력도 함께 확인 필요)`,
          });
        }
        const zaDc = za.category ? dcByIdentifier.get(za.category) : undefined;
        if (zaDc && zaDc.id !== base.damage_class_id) {
          proposals.push({
            target_table: 'version_move_legends_za',
            op: 'update',
            target_key: { id: base.id },
            field: 'damage_class_id',
            current_value: text(base.damage_class_id),
            proposed_value: text(zaDc.id),
            payload: null,
            source_values: { ...source, bulbapedia: za.category },
            confidence: 'conflict',
            note: `${move.identifier} ZA 분류 ${dcById.get(base.damage_class_id)?.name_ko} → ${zaDc.name_ko} (확인 필요)`,
          });
        }

        const zaFields = [
          { key: 'power', col: 'power', label: '위력' },
          { key: 'cooldown', col: 'cooldown', label: '쿨타임' },
          { key: 'windUp', col: 'frames_wind_up', label: '발동' },
          { key: 'duration', col: 'duration', label: '지속' },
        ] as const;
        for (const [variant, row, values] of [
          ['base', base, za.base],
          ['plus', plus, za.plus],
        ] as const) {
          if (!row) continue;
          for (const { key, col, label } of zaFields) {
            const value = values[key];
            if (value === undefined) continue;
            // 고정 데미지·무게 비례 기술은 Bulbapedia가 위력 1로 표시한다
            if (key === 'power' && value != null && value <= 1 && row.power == null) {
              skip('ZA 위력: 가변 위력');
              continue;
            }
            if (sameValue(key, value, row[col])) continue;
            proposals.push({
              target_table: 'version_move_legends_za',
              op: 'update',
              target_key: { id: row.id },
              field: col,
              current_value: text(row[col]),
              proposed_value: text(value),
              payload: null,
              source_values: { ...source, variant },
              confidence: row[col] == null ? 'high' : 'medium',
              note: `${move.identifier} ZA ${variant} ${label}${row[col] == null ? ' (빈 값 채움)' : ''}`,
            });
          }
        }
      }
    }
  }

  return { proposals, unparsedNotes, skipped };
};

// ─── history 단계 ────────────────────────────────────────────────

export const buildHistoryProposals = (
  db: DbState,
  snapshots: ParsedSnapshot[],
): { proposals: Proposal[]; existingDifferent: string[] } => {
  const proposals: Proposal[] = [];
  const existingDifferent: string[] = [];

  const moveById = new Map(db.moves.map((m) => [m.id, m]));
  const vgById = new Map(db.vgs.map((vg) => [vg.id, vg]));
  const typeName = new Map(db.types.map((t) => [t.id, t.name_ko]));
  const dcName = new Map(db.dcs.map((d) => [d.id, d.name_ko]));
  const mainline = db.vgs.filter(isMainline);
  const logged = new Map(db.log.map((l) => [`${l.move_id}|${l.vg}|${l.field}`, l]));
  const snapByMove = new Map(snapshots.map((s) => [s.moveId, s]));

  const fmt = (v: number | null) => (v == null ? '—' : String(v));
  const fields = [
    { label: '위력', get: (r: DbVersionMove) => fmt(r.power === 0 ? null : r.power), tooltip: 'power' },
    { label: 'PP', get: (r: DbVersionMove) => fmt(r.pp), tooltip: 'pp' },
    { label: '명중', get: (r: DbVersionMove) => fmt(r.accuracy), tooltip: 'accuracy' },
    { label: '우선도', get: (r: DbVersionMove) => fmt(r.priority), tooltip: 'priority' },
    // 1세대 일부 기술은 추가효과 없음이 0으로 저장돼 있다. 기존 기록 형식('—')에 맞춘다
    { label: '추가효과 확률', get: (r: DbVersionMove) => fmt(r.effect_chance === 0 ? null : r.effect_chance), tooltip: null },
    { label: '분류', get: (r: DbVersionMove) => (r.damage_class_id == null ? '—' : (dcName.get(r.damage_class_id) ?? '?')), tooltip: null },
    { label: '타입', get: (r: DbVersionMove) => typeName.get(r.type_id) ?? '?', tooltip: null },
  ] as const;

  const chains = new Map<number, DbVersionMove[]>();
  for (const row of db.vm) {
    if (!MAINLINE_VG(row.vg) || row.is_usable === false) continue;
    const list = chains.get(row.move_id) ?? [];
    list.push(row);
    chains.set(row.move_id, list);
  }

  for (const [moveId, chain] of chains) {
    chain.sort((a, b) => (vgById.get(a.vg)?.sort_order ?? 0) - (vgById.get(b.vg)?.sort_order ?? 0));
    const move = moveById.get(moveId);
    if (!move) continue;

    // 툴팁이 이전 값을 명시하면 high
    const box = snapByMove.get(moveId)?.infobox;
    const tooltipExpected = new Map<string, Map<number, number | null>>();
    for (const key of ['power', 'pp', 'accuracy', 'priority'] as const) {
      const fv = box?.fields[key];
      if (!fv?.history) continue;
      const current = parseNumber(fv.current);
      const segments = parseHistory(fv.history, db.vgs);
      if (current === undefined || !segments) continue;
      const explicit = new Map<number, number | null>();
      for (const [vgId, e] of expectedByVersionGroup(current, segments, mainline)) {
        if (e.explicit) explicit.set(vgId, e.value);
      }
      tooltipExpected.set(key, explicit);
    }

    for (let i = 1; i < chain.length; i += 1) {
      const prev = chain[i - 1];
      const next = chain[i];
      for (const f of fields) {
        const oldValue = f.get(prev);
        const newValue = f.get(next);
        if (oldValue === newValue) continue;

        const existing = logged.get(`${moveId}|${next.vg}|${f.label}`);
        if (existing) {
          if (existing.old !== oldValue || existing.new !== newValue) {
            existingDifferent.push(
              `${move.identifier} @${next.vg} ${f.label}: 기록 ${existing.old}→${existing.new} / 버전값 ${oldValue}→${newValue}`,
            );
          }
          continue;
        }

        const tooltipPrev = f.tooltip ? tooltipExpected.get(f.tooltip)?.get(prev.vg) : undefined;
        const confirmed = tooltipPrev !== undefined && fmt(tooltipPrev) === oldValue;
        proposals.push({
          target_table: 'move_change_log',
          op: 'insert',
          target_key: { move_id: moveId, version_group_id: next.vg, field: f.label },
          field: null,
          current_value: null,
          proposed_value: null,
          payload: {
            move_id: moveId,
            version_group_id: next.vg,
            field: f.label,
            old_value: oldValue,
            new_value: newValue,
          },
          source_values: { from_version_group_id: prev.vg, to_version_group_id: next.vg },
          confidence: confirmed ? 'high' : 'medium',
          note: `${move.identifier} ${f.label} ${oldValue} → ${newValue} @${next.vg}${confirmed ? ' (Bulbapedia 툴팁 확인)' : ''}`,
        });
      }
    }
  }

  return { proposals, existingDifferent };
};

// ─── 실행 ────────────────────────────────────────────────────────

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} 환경 변수가 없습니다 (.env.local 확인)`);
  return value;
};

const parsePhase = (): 'values' | 'history' => {
  const arg = process.argv.find((a) => a.startsWith('--phase='));
  const phase = arg?.slice('--phase='.length);
  if (phase !== 'values' && phase !== 'history') {
    throw new Error('사용법: generate-bulbapedia-move-proposals.mts --phase=values|history');
  }
  return phase;
};

const loadDbState = async (sql: postgres.Sql): Promise<DbState> => {
  // bigint는 문자열로 오므로 ::int로 받는다
  const [moves, vm, champ, za, types, dcs, vgs, log] = await Promise.all([
    sql<DbMove[]>`
      select id::int, identifier, power, pp, accuracy, priority, type_id::int,
             damage_class_id::int, is_contact
      from public.move`,
    sql<DbVersionMove[]>`
      select id::int, move_id::int, version_group_id::int as vg, power, pp, accuracy, priority,
             type_id::int, damage_class_id::int, effect_chance, is_usable
      from public.version_move`,
    sql<DbState['champ']>`
      select base_move_id::int, power, accuracy, type_id::int from public.champions_move`,
    sql<DbZa[]>`
      select id::int, base_move_id::int, za_variant as variant, power, cooldown, type_id::int,
             damage_class_id::int, frames_wind_up, duration
      from public.version_move_legends_za`,
    sql<DbState['types']>`select id::int, identifier, name_ko from public.type`,
    sql<DbState['dcs']>`select id::int, identifier, name_ko from public.damage_class`,
    sql<VersionGroup[]>`select id::int, generation, sort_order from public.version_group`,
    sql<DbState['log']>`
      select move_id::int, version_group_id::int as vg, field, old_value as old, new_value as new
      from public.move_change_log`,
  ]);
  return { moves, vm, champ, za, types, dcs, vgs, log };
};

const loadSnapshots = async (sql: postgres.Sql): Promise<ParsedSnapshot[]> => {
  const rows = await sql<{ entity_key: string; page_key: string; content: string }[]>`
    select distinct on (entity_key) entity_key, page_key, content
    from ingest.snapshot
    where source = 'bulbapedia' and entity_key like 'move:%'
    order by entity_key, fetched_at desc
  `;
  return rows.map((r) => ({
    moveId: Number(r.entity_key.slice('move:'.length)),
    pageKey: r.page_key,
    infobox: parseInfobox(r.content),
    za: parseLegendsZa(r.content),
  }));
};

const main = async () => {
  const phase = parsePhase();
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
    values ('generator', ${`bulbapedia-move:${phase}`})
    returning id
  `;
  const runId = run.id;
  const stats: Record<string, unknown> = {};

  try {
    if (phase === 'history') {
      const [{ pending }] = await sql<{ pending: number }[]>`
        select count(*)::int as pending from ingest.move_proposal
        where status = 'pending' and target_table in ('move', 'version_move')
      `;
      if (pending > 0) {
        throw new Error(
          `반영되지 않은 values 제안이 ${pending}건 있습니다. 먼저 반영하거나 거절한 뒤 history를 실행하세요`,
        );
      }
    }

    const [db, snapshots] = await Promise.all([loadDbState(sql), loadSnapshots(sql)]);
    stats.snapshots = snapshots.length;

    let proposals: Proposal[];
    if (phase === 'values') {
      const result = buildValueProposals(snapshots, db);
      proposals = result.proposals;
      stats.unparsedNotes = result.unparsedNotes;
      stats.skipped = result.skipped;
    } else {
      const result = buildHistoryProposals(db, snapshots);
      proposals = result.proposals;
      stats.existingDifferent = result.existingDifferent;
    }

    let inserted = 0;
    for (let i = 0; i < proposals.length; i += INSERT_BATCH_SIZE) {
      const batch = proposals.slice(i, i + INSERT_BATCH_SIZE);
      // 문자열(JSON.stringify)을 넘기면 jsonb로 한 번 더 감싸지므로 배열을 sql.json()으로 넘긴다
      const res = await sql<{ id: number }[]>`
        insert into ingest.move_proposal
          (run_id, target_table, op, target_key, field, current_value,
           proposed_value, payload, source_values, confidence, note)
        select ${runId}, r.target_table, r.op, r.target_key, r.field, r.current_value,
               r.proposed_value, r.payload, r.source_values, r.confidence, r.note
        from jsonb_to_recordset(${sql.json(batch as unknown as postgres.JSONValue)}::jsonb) as r(
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
      inserted += res.length;
    }

    const byKind: Record<string, number> = {};
    for (const p of proposals) {
      const k = `${p.target_table}.${p.field ?? p.op} [${p.confidence}]`;
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    Object.assign(stats, {
      proposals: proposals.length,
      inserted,
      skippedAsDuplicate: proposals.length - inserted,
      byKind,
    });

    await sql`
      update ingest.run
      set status = 'success', finished_at = now(), stats = ${sql.json(stats as postgres.JSONValue)}
      where id = ${runId}
    `;
    console.log(`[run ${runId}] success`, JSON.stringify(stats, null, 2));
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
