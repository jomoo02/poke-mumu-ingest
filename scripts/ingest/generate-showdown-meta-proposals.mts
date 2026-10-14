/**
 * Showdown 기술 데이터(data/moves.ts 스냅샷)로 기술 메타 제안을 ingest.move_proposal에 쓴다.
 *
 * 대상 테이블
 * - move_meta              기술당 1행: 급소·연속 공격·흡수/반동/회복·상태이상·풀죽음·일격필살·교체
 * - move_meta_stat_change  능력치 변화 (사용자/상대, 능력치, 랭크, 확률)
 *
 * 기준: Showdown 기본 데이터 = 최신 본가(현재 9세대). Champions 차이는 champions_move가 맡는다.
 *
 * 안전장치
 * - Showdown 파일은 실행하지 않고 TypeScript 구문 트리로만 읽는다.
 * - 기술 매칭(이름·번호)에 하나라도 실패하면 삭제 제안을 만들지 않는다.
 * - 같은 값으로 거절된 제안은 다시 만들지 않는다.
 * - public 스키마는 읽기만 한다 (ingest_bot 권한).
 *
 * 실행: node --env-file=.env.local scripts/ingest/generate-showdown-meta-proposals.mts
 */
import postgres from 'postgres';
import ts from 'typescript';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';
const FILE_BASE_MOVES = 'data/moves.ts';
const INSERT_BATCH_SIZE = 2000;

// ─── Showdown 값 읽기 (구문 트리 → 일반 값) ───────────────────────

export type Literal = string | number | boolean | null | Literal[] | { [key: string]: Literal };

const propertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
};

/** 리터럴로 표현되는 값만 읽는다. 함수 등은 undefined (무시) */
const toLiteral = (node: ts.Expression): Literal | undefined => {
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const v = toLiteral(node.operand);
    return typeof v === 'number' ? -v : undefined;
  }
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map((e) => toLiteral(e));
    return items.every((i) => i !== undefined) ? (items as Literal[]) : undefined;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const obj: { [key: string]: Literal } = {};
    for (const prop of node.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const key = propertyName(prop.name);
      const value = toLiteral(prop.initializer);
      if (key != null && value !== undefined) obj[key] = value;
    }
    return obj;
  }
  return undefined;
};

export const parseMoves = (source: string): Map<string, { [key: string]: Literal }> => {
  const file = ts.createSourceFile('moves.ts', source, ts.ScriptTarget.Latest);
  const moves = new Map<string, { [key: string]: Literal }>();
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const decl of statement.declarationList.declarations) {
      let init = decl.initializer;
      while (init && (ts.isAsExpression(init) || ts.isSatisfiesExpression(init))) init = init.expression;
      if (!init || !ts.isObjectLiteralExpression(init)) continue;
      for (const prop of init.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const id = propertyName(prop.name);
        const value = toLiteral(prop.initializer);
        if (id && value && typeof value === 'object' && !Array.isArray(value)) moves.set(id, value);
      }
    }
  }
  return moves;
};

// ─── Showdown → 메타 ─────────────────────────────────────────────

export type MetaRow = {
  move_id: number;
  crit_stage: number;
  always_crit: boolean;
  min_hits: number | null;
  max_hits: number | null;
  drain_percent: number | null;
  recoil_percent: number | null;
  heal_percent: number | null;
  ailment: string | null;
  ailment_chance: number | null;
  flinch_chance: number | null;
  ohko: boolean;
  switch_effect: 'self' | 'target' | null;
};

export type StatChangeRow = {
  move_id: number;
  target: 'user' | 'target';
  stat: string;
  stages: number;
  chance: number | null;
};

const STATUS: Record<string, string> = {
  par: 'paralysis',
  brn: 'burn',
  psn: 'poison',
  tox: 'bad-poison',
  slp: 'sleep',
  frz: 'freeze',
};

// 상태이상으로 볼 일시 상태. 그 밖의 일시 상태(도발·앵콜 등)는 효과 설명이 맡는다
const VOLATILE_AILMENT: Record<string, string> = {
  confusion: 'confusion',
  partiallytrapped: 'trap',
  attract: 'infatuation',
  leechseed: 'leech-seed',
  yawn: 'yawn',
  nightmare: 'nightmare',
  curse: 'curse',
  taunt: 'taunt',
  torment: 'torment',
  disable: 'disable',
  encore: 'encore',
  embargo: 'embargo',
  healblock: 'heal-block',
  telekinesis: 'telekinesis',
  perishsong: 'perish-song',
  saltcure: 'salt-cure',
  syrupbomb: 'syrup-bomb',
};

const STAT: Record<string, string> = {
  atk: 'attack',
  def: 'defense',
  spa: 'special_attack',
  spd: 'special_defense',
  spe: 'speed',
  accuracy: 'accuracy',
  evasion: 'evasion',
};

const asObject = (v: Literal | undefined): { [key: string]: Literal } | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? v : null;
const asNumber = (v: Literal | undefined): number | null => (typeof v === 'number' ? v : null);
const fractionPercent = (v: Literal | undefined): number | null =>
  Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' && v[1] !== 0
    ? Math.round((v[0] / v[1]) * 100)
    : null;

export const toMeta = (
  moveId: number,
  sd: { [key: string]: Literal },
): { meta: MetaRow; stats: StatChangeRow[] } => {
  const meta: MetaRow = {
    move_id: moveId,
    crit_stage: Math.max(0, (asNumber(sd.critRatio) ?? 1) - 1),
    always_crit: sd.willCrit === true,
    min_hits: null,
    max_hits: null,
    drain_percent: fractionPercent(sd.drain),
    recoil_percent: fractionPercent(sd.recoil),
    heal_percent: fractionPercent(sd.heal),
    ailment: null,
    ailment_chance: null,
    flinch_chance: null,
    ohko: sd.ohko != null && sd.ohko !== false,
    switch_effect: sd.selfSwitch ? 'self' : sd.forceSwitch ? 'target' : null,
  };

  if (typeof sd.multihit === 'number') {
    meta.min_hits = sd.multihit;
    meta.max_hits = sd.multihit;
  } else if (Array.isArray(sd.multihit) && typeof sd.multihit[0] === 'number' && typeof sd.multihit[1] === 'number') {
    meta.min_hits = sd.multihit[0];
    meta.max_hits = sd.multihit[1];
  }

  const stats = new Map<string, StatChangeRow>();
  const addBoosts = (boosts: Literal | undefined, target: 'user' | 'target', chance: number | null) => {
    const obj = asObject(boosts);
    if (!obj) return;
    for (const [key, value] of Object.entries(obj)) {
      const stat = STAT[key];
      if (!stat || typeof value !== 'number') continue;
      stats.set(`${target}|${stat}`, { move_id: moveId, target, stat, stages: value, chance });
    }
  };
  const setAilment = (code: string | undefined, chance: number | null) => {
    if (!code || meta.ailment) return;
    const name = STATUS[code] ?? VOLATILE_AILMENT[code];
    if (name) {
      meta.ailment = name;
      meta.ailment_chance = chance;
    }
  };

  // 변화 기술 본체
  const selfTarget = sd.target === 'self' || sd.target === 'allySide' || sd.target === 'allies';
  addBoosts(sd.boosts, selfTarget ? 'user' : 'target', null);
  addBoosts(asObject(sd.self)?.boosts, 'user', null);
  if (typeof sd.status === 'string') setAilment(sd.status, null);
  if (typeof sd.volatileStatus === 'string') setAilment(sd.volatileStatus, null);

  // 추가효과
  const secondaries = [
    ...(asObject(sd.secondary) ? [asObject(sd.secondary)!] : []),
    ...(Array.isArray(sd.secondaries) ? sd.secondaries.map((s) => asObject(s)).filter((s) => s != null) : []),
  ];
  for (const s of secondaries) {
    const chance = asNumber(s.chance);
    if (typeof s.status === 'string') setAilment(s.status, chance);
    if (s.volatileStatus === 'flinch') meta.flinch_chance = chance;
    else if (typeof s.volatileStatus === 'string') setAilment(s.volatileStatus, chance);
    addBoosts(s.boosts, 'target', chance);
    addBoosts(asObject(s.self)?.boosts, 'user', chance);
  }

  return { meta, stats: [...stats.values()] };
};

// ─── 제안 ────────────────────────────────────────────────────────

export type Proposal = {
  target_table: 'move_meta' | 'move_meta_stat_change';
  op: 'insert' | 'update' | 'delete';
  target_key: Record<string, string | number>;
  field: string | null;
  current_value: string | null;
  proposed_value: string | null;
  payload: Record<string, string | number | boolean | null> | null;
  source_values: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'conflict';
  note: string;
};

const text = (v: unknown): string | null => (v == null ? null : String(v));
const META_FIELDS = [
  'crit_stage', 'always_crit', 'min_hits', 'max_hits', 'drain_percent', 'recoil_percent',
  'heal_percent', 'ailment', 'ailment_chance', 'flinch_chance', 'ohko', 'switch_effect',
] as const;

export const toShowdownId = (identifier: string): string =>
  identifier.toLowerCase().replace(/[^a-z0-9]/g, '');

export const buildProposals = (
  sdMoves: Map<string, { [key: string]: Literal }>,
  db: {
    moves: { id: number; identifier: string; move_number: number }[];
    meta: MetaRow[];
    stats: StatChangeRow[];
  },
): { proposals: Proposal[]; unmatched: string[] } => {
  const proposals: Proposal[] = [];
  const unmatched: string[] = [];
  const metaByMove = new Map(db.meta.map((m) => [m.move_id, m]));
  const statKey = (s: { move_id: number; target: string; stat: string }) => `${s.move_id}|${s.target}|${s.stat}`;
  const existingStats = new Map(db.stats.map((s) => [statKey(s), s]));
  const wantedStats = new Map<string, StatChangeRow>();

  for (const move of db.moves) {
    const sdId = toShowdownId(move.identifier);
    const sd = sdMoves.get(sdId);
    if (!sd || sd.num !== move.move_number) {
      unmatched.push(sd ? `${move.identifier} (번호 ${String(sd.num)} ≠ ${move.move_number})` : move.identifier);
      continue;
    }
    const { meta, stats } = toMeta(move.id, sd);
    const source = { showdown_id: sdId };

    const existing = metaByMove.get(move.id);
    if (!existing) {
      proposals.push({
        target_table: 'move_meta',
        op: 'insert',
        target_key: { move_id: move.id },
        field: null,
        current_value: null,
        proposed_value: null,
        payload: meta,
        source_values: source,
        confidence: 'high',
        note: `${move.identifier} 메타`,
      });
    } else {
      for (const field of META_FIELDS) {
        if (existing[field] === meta[field]) continue;
        proposals.push({
          target_table: 'move_meta',
          op: 'update',
          target_key: { move_id: move.id },
          field,
          current_value: text(existing[field]),
          proposed_value: text(meta[field]),
          payload: null,
          source_values: source,
          confidence: 'medium',
          note: `${move.identifier} 메타 ${field}`,
        });
      }
    }

    for (const s of stats) {
      const key = statKey(s);
      wantedStats.set(key, s);
      const cur = existingStats.get(key);
      if (!cur) {
        proposals.push({
          target_table: 'move_meta_stat_change',
          op: 'insert',
          target_key: { move_id: s.move_id, target: s.target, stat: s.stat },
          field: null,
          current_value: null,
          proposed_value: null,
          payload: s,
          source_values: source,
          confidence: 'high',
          note: `${move.identifier} ${s.target === 'user' ? '자신' : '상대'} ${s.stat} ${s.stages > 0 ? '+' : ''}${s.stages}${s.chance != null ? ` (${s.chance}%)` : ''}`,
        });
        continue;
      }
      for (const field of ['stages', 'chance'] as const) {
        if (cur[field] === s[field]) continue;
        proposals.push({
          target_table: 'move_meta_stat_change',
          op: 'update',
          target_key: { move_id: s.move_id, target: s.target, stat: s.stat },
          field,
          current_value: text(cur[field]),
          proposed_value: text(s[field]),
          payload: null,
          source_values: source,
          confidence: 'medium',
          note: `${move.identifier} ${s.stat} ${field}`,
        });
      }
    }
  }

  // 매칭이 완전할 때만 Showdown에 없는 능력치 변화를 지운다
  if (unmatched.length === 0) {
    for (const [key, s] of existingStats) {
      if (wantedStats.has(key)) continue;
      proposals.push({
        target_table: 'move_meta_stat_change',
        op: 'delete',
        target_key: { move_id: s.move_id, target: s.target, stat: s.stat },
        field: null,
        current_value: null,
        proposed_value: null,
        payload: null,
        source_values: {},
        confidence: 'medium',
        note: 'Showdown 데이터에 없음',
      });
    }
  }

  return { proposals, unmatched };
};

// ─── 실행 ────────────────────────────────────────────────────────

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) throw new Error(`${key} 환경 변수가 없습니다 (.env.local 확인)`);
  return value;
};

const main = async () => {
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
    insert into ingest.run (source, scope) values ('generator', 'showdown-meta') returning id
  `;
  const runId = run.id;
  const stats: Record<string, unknown> = {};

  try {
    const [snap] = await sql<{ id: number; content: string }[]>`
      select id::int, content from ingest.snapshot
      where source = 'showdown' and page_key = ${FILE_BASE_MOVES}
      order by fetched_at desc limit 1
    `;
    if (!snap) throw new Error('Showdown 스냅샷이 없습니다. fetch-showdown-snapshot을 먼저 실행하세요');
    stats.snapshotId = snap.id;

    // bigint는 문자열로 오므로 ::int로 받는다
    const [moves, meta, statRows] = await Promise.all([
      sql<{ id: number; identifier: string; move_number: number }[]>`
        select id::int, identifier, move_number::int from public.move`,
      sql<MetaRow[]>`select move_id::int, crit_stage, always_crit, min_hits, max_hits, drain_percent,
        recoil_percent, heal_percent, ailment, ailment_chance, flinch_chance, ohko, switch_effect
        from public.move_meta`,
      sql<StatChangeRow[]>`select move_id::int, target, stat, stages, chance from public.move_meta_stat_change`,
    ]);

    const { proposals, unmatched } = buildProposals(parseMoves(snap.content), { moves, meta, stats: statRows });

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
      const k = `${p.target_table} ${p.op}`;
      byKind[k] = (byKind[k] ?? 0) + 1;
    }
    Object.assign(stats, { unmatched, proposals: proposals.length, inserted, skippedAsDuplicate: proposals.length - inserted, byKind });

    const status = unmatched.length > 0 ? 'partial' : 'success';
    await sql`
      update ingest.run set status = ${status}, finished_at = now(),
        stats = ${sql.json(stats as postgres.JSONValue)} where id = ${runId}
    `;
    console.log(`[run ${runId}] ${status}`, JSON.stringify(stats, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update ingest.run set status = 'failed', finished_at = now(),
        stats = ${sql.json(stats as postgres.JSONValue)}, error = ${message} where id = ${runId}
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
