/**
 * Bulbapedia "List of moves by availability in Generation VII·VIII·IX" 원문을 ingest.snapshot에 저장한다.
 * 본편 버전별 사용 가능 여부(version_move.is_usable)의 기준 표다.
 *
 * - public 스키마는 읽기만 한다 (ingest_bot 권한).
 * - 같은 내용은 다시 저장하지 않는다 (source, page_key, content_hash 유니크).
 * - 요청·재시도 규칙은 fetch-move-snapshot.mts와 같다.
 *
 * 실행:
 *   node --env-file=.env.local scripts/ingest/fetch-availability-snapshot.mts
 */
import postgres from 'postgres';

import { AVAILABILITY_PAGES } from './bulbapedia-availability-parser.mts';
import { fetchRevisions, hashContent, resolveTitle } from './fetch-move-snapshot.mts';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';

type RunStats = {
  inserted: string[];
  unchanged: string[];
  missingPage: string[];
  retries: number;
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

  const stats: RunStats = { inserted: [], unchanged: [], missingPage: [], retries: 0 };
  const [run] = await sql<{ id: number }[]>`
    insert into ingest.run (source, scope) values ('bulbapedia', 'availability:gen7-9') returning id
  `;
  const runId = run.id;

  try {
    const titles = AVAILABILITY_PAGES.map((p) => p.title);
    const { query } = await fetchRevisions(titles, (reason, waitMs, attempt) => {
      stats.retries += 1;
      console.warn(`  ${reason} → ${Math.round(waitMs / 1000)}초 후 다시 시도 (${attempt})`);
    });
    if (!query?.pages) throw new Error('Bulbapedia API 응답에 pages가 없습니다');
    const pageByTitle = new Map(query.pages.map((page) => [page.title, page]));

    for (const { entityKey, title } of AVAILABILITY_PAGES) {
      const resolved = resolveTitle(title, query);
      const revision = pageByTitle.get(resolved)?.revisions?.[0];
      if (!revision) {
        stats.missingPage.push(title);
        continue;
      }
      const content = revision.slots.main.content;
      const inserted = await sql`
        insert into ingest.snapshot (run_id, source, page_key, entity_key, rev_id, content, content_hash)
        values (${runId}, 'bulbapedia', ${resolved}, ${entityKey}, ${revision.revid}, ${content},
                ${hashContent(content)})
        on conflict (source, page_key, content_hash) do nothing
        returning id
      `;
      (inserted.length > 0 ? stats.inserted : stats.unchanged).push(entityKey);
    }

    const status = stats.missingPage.length > 0 ? 'partial' : 'success';
    await sql`
      update ingest.run set status = ${status}, finished_at = now(), stats = ${sql.json(stats)}
      where id = ${runId}
    `;
    console.log(`[run ${runId}] ${status}`, stats);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update ingest.run set status = 'failed', finished_at = now(), stats = ${sql.json(stats)},
             error = ${message}
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
