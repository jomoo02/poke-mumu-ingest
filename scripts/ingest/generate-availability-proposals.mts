/**
 * Bulbapedia 사용 가능 표(ingest.snapshot의 availability:gen7·8·9)와 version_move.is_usable을 비교해
 * 다른 행을 ingest.move_proposal에 is_usable 수정 제안으로 쓴다.
 *
 * 규칙
 * - 표의 {{yes}}만 사용 가능. {{no}}와 빈칸은 사용 불가.
 * - 표와 DB는 기술 번호(move.move_number)로 맞춘다. DB id는 Z기술 이후 번호와 다르다.
 * - Z기술처럼 같은 이름이 두 번호로 나오는 행은 하나로 합친다 (parseAvailabilityTable).
 * - 본편 버전만 다룬다. 레전드 아르세우스(20)·레전드 Z-A(22)는 각자 테이블에서 다루므로
 *   비교하지 않고 개수만 기록한다.
 * - version_move 행이 없는 기술은 제안하지 않고 목록으로만 남긴다 (행을 만들려면 값이 필요).
 * - 같은 대상·같은 값으로 거절된 제안은 다시 만들지 않는다.
 *
 * 실행 (fetch-availability-snapshot.mts 다음):
 *   node --env-file=.env.local scripts/ingest/generate-availability-proposals.mts
 */
import postgres from 'postgres';

import {
  AVAILABILITY_PAGES,
  parseAvailabilityTable,
  type ParsedAvailability,
} from './bulbapedia-availability-parser.mts';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';
const INSERT_BATCH_SIZE = 2000;

/** 이 생성기가 바로잡는 본편 버전 그룹 */
const MAINLINE_VGS = new Set([15, 16, 17, 18, 19, 21]);

export type DbVersionMove = {
  id: number;
  move_id: number;
  move_number: number;
  identifier: string;
  vg: number;
  is_usable: boolean | null;
};

export type Proposal = {
  target_table: 'version_move';
  op: 'update';
  target_key: { id: number };
  field: 'is_usable';
  current_value: string;
  proposed_value: string;
  payload: null;
  source_values: Record<string, unknown>;
  confidence: 'high';
  note: string;
};

export const buildAvailabilityProposals = (
  tables: { entityKey: string; revId: number | null; parsed: ParsedAvailability }[],
  versionMoves: DbVersionMove[],
): { proposals: Proposal[]; stats: Record<string, unknown> } => {
  const proposals: Proposal[] = [];
  const usableCount: Record<number, number> = {};
  const missingRows: string[] = [];
  const unknownNumbers: number[] = [];

  const vmByKey = new Map(versionMoves.map((v) => [`${v.move_number}:${v.vg}`, v]));
  const knownNumbers = new Set(versionMoves.map((v) => v.move_number));

  for (const { entityKey, revId, parsed } of tables) {
    for (const row of parsed.rows.values()) {
      for (const [vg, usable] of row.usable) {
        if (usable) usableCount[vg] = (usableCount[vg] ?? 0) + 1;
        if (!MAINLINE_VGS.has(vg)) continue;

        const vm = vmByKey.get(`${row.moveNumber}:${vg}`);
        if (!vm) {
          // 본편에서 쓸 수 없는 기술(예: Z-A 전용)은 version_move 행이 없어도 정상이다
          if (!usable) continue;
          if (!knownNumbers.has(row.moveNumber)) unknownNumbers.push(row.moveNumber);
          else missingRows.push(`${row.moveNumber} ${row.name} @${vg}`);
          continue;
        }
        const current = vm.is_usable !== false;
        if (current === usable) continue;
        proposals.push({
          target_table: 'version_move',
          op: 'update',
          target_key: { id: vm.id },
          field: 'is_usable',
          current_value: String(vm.is_usable),
          proposed_value: String(usable),
          payload: null,
          source_values: {
            source: 'bulbapedia availability table',
            entity_key: entityKey,
            rev_id: revId,
            move_id: vm.move_id,
            move_number: row.moveNumber,
            name_en: row.name,
            version_group_id: vg,
          },
          confidence: 'high',
          note: `${vm.identifier} @${vg} 사용 ${usable ? '가능' : '불가'} (표)`,
        });
      }
    }
  }

  return {
    proposals,
    stats: {
      usableCount,
      missingRows,
      unknownNumbers: [...new Set(unknownNumbers)],
    },
  };
};

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
    insert into ingest.run (source, scope) values ('generator', 'availability') returning id
  `;
  const runId = run.id;
  let stats: Record<string, unknown> = {};

  try {
    const keys = AVAILABILITY_PAGES.map((p) => p.entityKey);
    const snapshots = await sql<{ entity_key: string; rev_id: number | null; content: string }[]>`
      select distinct on (entity_key) entity_key, rev_id::int, content
      from ingest.snapshot
      where source = 'bulbapedia' and entity_key in ${sql(keys)}
      order by entity_key, fetched_at desc
    `;
    const missing = keys.filter((k) => !snapshots.some((s) => s.entity_key === k));
    if (missing.length > 0) {
      throw new Error(`원문이 없습니다: ${missing.join(', ')} (fetch-availability-snapshot.mts 먼저 실행)`);
    }
    // 표 형식이 바뀌면 parseAvailabilityTable이 예외를 던져 제안 없이 끝난다
    const tables = snapshots.map((s) => ({
      entityKey: s.entity_key,
      revId: s.rev_id,
      parsed: parseAvailabilityTable(s.content),
    }));

    const versionMoves = await sql<DbVersionMove[]>`
      select v.id::int, v.move_id::int, m.move_number::int, m.identifier,
             v.version_group_id::int as vg, v.is_usable
      from public.version_move v join public.move m on m.id = v.move_id
    `;

    const result = buildAvailabilityProposals(tables, versionMoves);
    stats = result.stats;

    let inserted = 0;
    for (let i = 0; i < result.proposals.length; i += INSERT_BATCH_SIZE) {
      const batch = result.proposals.slice(i, i + INSERT_BATCH_SIZE);
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
        where not exists (
          select 1 from ingest.move_proposal x
          where x.status = 'rejected'
            and x.target_table = r.target_table and x.op = r.op and x.target_key = r.target_key
            and coalesce(x.field, '') = coalesce(r.field, '')
            and x.proposed_value is not distinct from r.proposed_value
        )
        on conflict (target_table, op, target_key, (coalesce(field, ''))) where status = 'pending'
        do nothing
        returning id
      `;
      inserted += res.length;
    }
    stats = { ...stats, proposals: result.proposals.length, inserted };

    await sql`
      update ingest.run set status = 'success', finished_at = now(), stats = ${sql.json(stats as postgres.JSONValue)}
      where id = ${runId}
    `;
    console.log(`[run ${runId}] success`, stats);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update ingest.run set status = 'failed', finished_at = now(),
             stats = ${sql.json(stats as postgres.JSONValue)}, error = ${message}
      where id = ${runId}
    `;
    console.error(`[run ${runId}] failed: ${message}`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
};

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
