/**
 * 최신 Showdown 스냅샷과 현재 DB를 비교해 Champions 배우는 기술 제안을 ingest.move_proposal에 쓴다.
 *
 * 만드는 제안 (대상: champions_poke_move)
 * - insert: Showdown에는 있는데 DB에 없는 (포켓몬, 기술)
 * - delete: 별칭 포켓몬(메가진화 등) 행. owner 행이 있어 champions_learnset 뷰가 읽지 않는 중복
 * - delete: Showdown 기준 Champions에서 배우지 않는 (포켓몬, 기술)
 *
 * 저장 원칙: learnset 테이블에는 owner 포켓몬(learnset_owner_key가 없는 쪽)만 저장한다.
 * 별칭은 champions_learnset 뷰가 owner로 풀어서 보여준다.
 *
 * 포켓몬 매핑: Showdown ID = poke_key에서 영숫자만 남긴 것.
 *   예외: 암컷 폼 (Showdown forme "F", 예: meowsticf) → <기본종 poke_key>-female
 *   도감번호가 다르면 매핑 실패로 본다.
 *
 * 안전장치
 * - Showdown 파일은 실행하지 않고 TypeScript 구문 트리로만 읽는다.
 * - 포켓몬·기술 매핑에 하나라도 실패하면 삭제 제안을 만들지 않는다.
 * - 같은 owner로 모이는 Showdown 폼끼리 learnset이 다르면 그 owner는 건너뛰고 기록한다.
 * - owner 행 삭제 제안이 비정상적으로 많으면 (Showdown 데이터 이상 의심) 실패로 끝낸다.
 * - public 스키마는 읽기만 한다 (ingest_bot 권한).
 *
 * 실행: node --env-file=.env.local scripts/ingest/generate-champions-learnset-proposals.mts
 */
import postgres from 'postgres';
import ts from 'typescript';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';

const FILE_LEARNSETS = 'data/mods/champions/learnsets.ts';
const FILE_POKEDEX = 'data/pokedex.ts';

// 한 번에 넣는 제안 수 (쿼리 파라미터 크기 제한)
const INSERT_BATCH_SIZE = 2000;

// owner 행 삭제가 이보다 많으면 데이터 이상으로 보고 멈춘다
const MAX_OWNER_DELETES = 50;

// ─── Showdown 데이터 (구문 트리로 읽은 값) ─────────────────────────

export type ShowdownSpecies = {
  num: number;
  name: string;
  baseSpecies: string | null;
  forme: string | null;
};

const propertyName = (name: ts.PropertyName): string | null => {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return null;
};

/** `export const X = { id: { ... }, ... }` 의 최상위 객체 항목들 */
const topLevelEntries = (
  source: string,
): [string, ts.ObjectLiteralExpression][] => {
  const file = ts.createSourceFile('data.ts', source, ts.ScriptTarget.Latest);
  const entries: [string, ts.ObjectLiteralExpression][] = [];

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
          entries.push([id, prop.initializer]);
        }
      }
    }
  }
  return entries;
};

const findProperty = (
  obj: ts.ObjectLiteralExpression,
  key: string,
): ts.Expression | undefined =>
  obj.properties.find(
    (p): p is ts.PropertyAssignment =>
      ts.isPropertyAssignment(p) && propertyName(p.name) === key,
  )?.initializer;

/** learnsets.ts → 포켓몬 ID별 Showdown 기술 ID 집합 (learnset이 없는 항목은 제외) */
export const parseLearnsets = (source: string): Map<string, Set<string>> => {
  const result = new Map<string, Set<string>>();
  for (const [speciesId, entry] of topLevelEntries(source)) {
    const learnset = findProperty(entry, 'learnset');
    if (!learnset || !ts.isObjectLiteralExpression(learnset)) continue;

    const moves = new Set<string>();
    for (const prop of learnset.properties) {
      if (!ts.isPropertyAssignment(prop)) continue;
      const moveId = propertyName(prop.name);
      if (moveId) moves.add(moveId);
    }
    result.set(speciesId, moves);
  }
  return result;
};

/** pokedex.ts → 포켓몬 ID별 도감번호·이름·기본종·폼 */
export const parsePokedex = (source: string): Map<string, ShowdownSpecies> => {
  const result = new Map<string, ShowdownSpecies>();
  for (const [speciesId, entry] of topLevelEntries(source)) {
    const num = findProperty(entry, 'num');
    const name = findProperty(entry, 'name');
    const baseSpecies = findProperty(entry, 'baseSpecies');
    const forme = findProperty(entry, 'forme');

    let numValue: number | null = null;
    if (num && ts.isNumericLiteral(num)) numValue = Number(num.text);
    if (
      num &&
      ts.isPrefixUnaryExpression(num) &&
      num.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(num.operand)
    ) {
      numValue = -Number(num.operand.text);
    }
    if (numValue == null || !name || !ts.isStringLiteralLike(name)) continue;

    result.set(speciesId, {
      num: numValue,
      name: name.text,
      baseSpecies: baseSpecies && ts.isStringLiteralLike(baseSpecies) ? baseSpecies.text : null,
      forme: forme && ts.isStringLiteralLike(forme) ? forme.text : null,
    });
  }
  return result;
};

/** Showdown ID 규칙: 소문자, 영숫자만 */
export const toShowdownId = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');

// ─── DB 상태 ─────────────────────────────────────────────────────

export type DbPoke = {
  poke_key: string;
  learnset_owner_key: string | null;
  dex_number: number | null;
};

export type DbState = {
  pokes: DbPoke[];
  moves: { id: number; identifier: string }[];
  rows: { id: number; poke_key: string; move_id: number }[];
};

// ─── 제안 ────────────────────────────────────────────────────────

export type Proposal = {
  target_table: 'champions_poke_move';
  op: 'insert' | 'delete';
  target_key: Record<string, string | number>;
  field: null;
  current_value: null;
  proposed_value: null;
  payload: Record<string, string | number> | null;
  source_values: Record<string, unknown>;
  confidence: 'high' | 'medium' | 'conflict';
  note: string;
};

export type BuildResult = {
  proposals: Proposal[];
  unmatchedSpecies: string[];
  unmatchedMoves: string[];
  ownerConflicts: string[];
  owners: number;
  pairs: number;
};

export const buildProposals = (
  learnsets: Map<string, Set<string>>,
  pokedex: Map<string, ShowdownSpecies>,
  db: DbState,
): BuildResult => {
  const proposals: Proposal[] = [];
  const unmatchedSpecies: string[] = [];
  const unmatchedMoves = new Set<string>();
  const ownerConflicts: string[] = [];

  const pokeByKey = new Map(db.pokes.map((p) => [p.poke_key, p]));
  const pokeBySdId = new Map(db.pokes.map((p) => [toShowdownId(p.poke_key), p]));
  const moveIdBySdId = new Map(db.moves.map((m) => [toShowdownId(m.identifier), m.id]));
  const ownerOf = (key: string) => pokeByKey.get(key)?.learnset_owner_key ?? key;

  // 1) Showdown 포켓몬 → DB owner, 같은 owner에 모이는 폼은 learnset이 같아야 한다
  const desiredByOwner = new Map<string, { moves: Set<string>; from: string[] }>();
  for (const [sdId, moves] of learnsets) {
    const dex = pokedex.get(sdId);
    let poke = pokeBySdId.get(sdId);
    if (!poke && dex?.forme === 'F' && dex.baseSpecies) {
      const base = pokeBySdId.get(toShowdownId(dex.baseSpecies));
      poke = base ? pokeByKey.get(`${base.poke_key}-female`) : undefined;
    }
    if (!poke || (dex && poke.dex_number !== dex.num)) {
      unmatchedSpecies.push(dex ? `${sdId} (No.${dex.num})` : sdId);
      continue;
    }

    const owner = ownerOf(poke.poke_key);
    const existing = desiredByOwner.get(owner);
    if (!existing) {
      desiredByOwner.set(owner, { moves, from: [sdId] });
      continue;
    }
    const same =
      existing.moves.size === moves.size && [...moves].every((m) => existing.moves.has(m));
    if (!same) ownerConflicts.push(`${owner}: ${[...existing.from, sdId].join(' ≠ ')}`);
    existing.from.push(sdId);
  }
  for (const conflict of ownerConflicts) desiredByOwner.delete(conflict.split(':')[0]);

  // 2) 원하는 (owner, move_id) 집합
  const desired = new Map<string, { owner: string; moveId: number; sdMove: string; from: string[] }>();
  for (const [owner, { moves, from }] of desiredByOwner) {
    for (const sdMove of moves) {
      const moveId = moveIdBySdId.get(sdMove);
      if (moveId == null) {
        unmatchedMoves.add(sdMove);
        continue;
      }
      desired.set(`${owner}|${moveId}`, { owner, moveId, sdMove, from });
    }
  }

  // 3) 현재 DB 행 분류
  const existingOwnerPairs = new Set<string>();
  const aliasRows: DbState['rows'] = [];
  const ownerRows: DbState['rows'] = [];
  for (const row of db.rows) {
    if (ownerOf(row.poke_key) !== row.poke_key) aliasRows.push(row);
    else {
      ownerRows.push(row);
      existingOwnerPairs.add(`${row.poke_key}|${row.move_id}`);
    }
  }

  // 4) 추가
  for (const [key, { owner, moveId, sdMove, from }] of desired) {
    if (existingOwnerPairs.has(key)) continue;
    proposals.push({
      target_table: 'champions_poke_move',
      op: 'insert',
      target_key: { poke_key: owner, move_id: moveId },
      field: null,
      current_value: null,
      proposed_value: null,
      payload: { poke_key: owner, move_id: moveId },
      source_values: { showdown_species: from, showdown_move: sdMove },
      confidence: 'medium',
      note: 'Showdown Champions learnset',
    });
  }

  // 5) 삭제: 매핑이 완전할 때만
  const mappingComplete = unmatchedSpecies.length === 0 && unmatchedMoves.size === 0;
  if (mappingComplete) {
    for (const row of aliasRows) {
      const owner = ownerOf(row.poke_key);
      const ownerKey = `${owner}|${row.move_id}`;
      // owner 행이 이미 있거나 이번에 추가될 때만 high. 아니면 지우면 정보가 사라지므로 conflict
      const ownerCovered = existingOwnerPairs.has(ownerKey) || desired.has(ownerKey);
      proposals.push({
        target_table: 'champions_poke_move',
        op: 'delete',
        target_key: { id: row.id },
        field: null,
        current_value: null,
        proposed_value: null,
        payload: null,
        source_values: { poke_key: row.poke_key, owner, move_id: row.move_id },
        confidence: ownerCovered ? 'high' : 'conflict',
        note: ownerCovered
          ? `별칭 행 (${row.poke_key} → ${owner} 행으로 해석됨)`
          : `별칭 행이지만 ${owner}에 같은 기술 행이 없음`,
      });
    }

    const ownerDeletes = ownerRows.filter(
      (row) => !desired.has(`${row.poke_key}|${row.move_id}`) && !ownerConflicts.some((c) => c.startsWith(`${row.poke_key}:`)),
    );
    if (ownerDeletes.length > MAX_OWNER_DELETES) {
      throw new Error(
        `Showdown 기준으로 지워야 할 기존 행이 ${ownerDeletes.length}개입니다 (한도 ${MAX_OWNER_DELETES}). 데이터 이상이 의심되어 멈춥니다`,
      );
    }
    for (const row of ownerDeletes) {
      proposals.push({
        target_table: 'champions_poke_move',
        op: 'delete',
        target_key: { id: row.id },
        field: null,
        current_value: null,
        proposed_value: null,
        payload: null,
        source_values: { poke_key: row.poke_key, move_id: row.move_id },
        confidence: 'medium',
        note: 'Showdown Champions learnset에 없음',
      });
    }
  }

  return {
    proposals,
    unmatchedSpecies,
    unmatchedMoves: [...unmatchedMoves],
    ownerConflicts,
    owners: desiredByOwner.size,
    pairs: desired.size,
  };
};

// ─── 실행 ────────────────────────────────────────────────────────

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} 환경 변수가 없습니다 (.env.local 확인)`);
  }
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
    insert into ingest.run (source, scope)
    values ('generator', 'champions-learnset')
    returning id
  `;
  const runId = run.id;
  const stats: Record<string, unknown> = {};

  try {
    const snapshots = await sql<{ id: number; page_key: string; content: string }[]>`
      select distinct on (page_key) id::int, page_key, content
      from ingest.snapshot
      where source = 'showdown' and page_key in (${FILE_LEARNSETS}, ${FILE_POKEDEX})
      order by page_key, fetched_at desc
    `;
    const byPath = new Map(snapshots.map((s) => [s.page_key, s]));
    const learnsetSnap = byPath.get(FILE_LEARNSETS);
    const pokedexSnap = byPath.get(FILE_POKEDEX);
    if (!learnsetSnap || !pokedexSnap) {
      throw new Error('Showdown 스냅샷이 없습니다. fetch-showdown-snapshot을 먼저 실행하세요');
    }
    stats.snapshotIds = { learnsets: learnsetSnap.id, pokedex: pokedexSnap.id };

    // bigint 칸은 postgres 라이브러리가 문자열로 돌려주므로 ::int로 바꿔 받는다
    const [pokes, moves, rows] = await Promise.all([
      sql<DbPoke[]>`select poke_key, learnset_owner_key, dex_number::int from public.poke`,
      sql<{ id: number; identifier: string }[]>`select id::int, identifier from public.move`,
      sql<{ id: number; poke_key: string; move_id: number }[]>`
        select id::int, poke_key, move_id::int from public.champions_poke_move
      `,
    ]);

    const result = buildProposals(
      parseLearnsets(learnsetSnap.content),
      parsePokedex(pokedexSnap.content),
      { pokes, moves, rows },
    );
    const { proposals } = result;

    // 나눠서 넣는다. 같은 대상에 pending 제안이 이미 있으면 건너뛴다
    // 문자열(JSON.stringify)을 넘기면 jsonb로 한 번 더 감싸지므로 배열을 sql.json()으로 넘긴다
    let inserted = 0;
    for (let i = 0; i < proposals.length; i += INSERT_BATCH_SIZE) {
      const batch = proposals.slice(i, i + INSERT_BATCH_SIZE);
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

    const count = (op: string, confidence?: string) =>
      proposals.filter((p) => p.op === op && (!confidence || p.confidence === confidence)).length;
    Object.assign(stats, {
      owners: result.owners,
      pairs: result.pairs,
      unmatchedSpecies: result.unmatchedSpecies,
      unmatchedMoves: result.unmatchedMoves,
      ownerConflicts: result.ownerConflicts,
      existingRows: rows.length,
      proposals: proposals.length,
      inserted,
      skippedAsDuplicate: proposals.length - inserted,
      byKind: {
        insert: count('insert'),
        'delete alias (high)': count('delete', 'high'),
        'delete alias (conflict)': count('delete', 'conflict'),
        'delete not in showdown': count('delete', 'medium'),
      },
    });

    const clean =
      result.unmatchedSpecies.length === 0 &&
      result.unmatchedMoves.length === 0 &&
      result.ownerConflicts.length === 0;
    const status = clean ? 'success' : 'partial';
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
