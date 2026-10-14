/**
 * Pokémon Showdown 저장소의 Champions 관련 데이터 파일 원문을 ingest.snapshot에 저장한다.
 *
 * - 모든 파일을 같은 커밋에서 받는다 (중간에 저장소가 바뀌어도 파일끼리 어긋나지 않게).
 * - 받은 파일은 실행하지 않는다. 원문만 저장하고, 해석은 다음 단계 파서가 구문 트리로 한다.
 * - 같은 파일의 같은 내용은 다시 저장하지 않는다 (source, page_key, content_hash 유니크).
 * - public 스키마는 건드리지 않는다.
 *
 * 실행:
 *   node --env-file=.env.local scripts/ingest/fetch-showdown-snapshot.mts
 *   node scripts/ingest/fetch-showdown-snapshot.mts --dry-run   (DB 없이 받기만 확인)
 */
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';
const REPO = 'smogon/pokemon-showdown';
const USER_AGENT =
  'poke-mumu-ingest/0.1 (+https://github.com/jomoo02/poke-mumu)';
const REQUEST_INTERVAL_MS = 300;

// 무엇을 왜 받는지
const FILES = [
  // 전 기술 기본값과 isNonstandard(사용 가능 여부)
  'data/moves.ts',
  // Champions에서 바뀐 수치·사용 가능 여부 덮어쓰기
  'data/mods/champions/moves.ts',
  // Champions 배우는 기술
  'data/mods/champions/learnsets.ts',
  // PP 공식 등 Champions 전역 규칙 (공식이 바뀌면 감지하기 위해)
  'data/mods/champions/scripts.ts',
  // 폼 포켓몬 ID → poke_key 매핑에 필요한 baseSpecies·forme 정보
  'data/pokedex.ts',
] as const;

type FileResult = {
  path: string;
  bytes: number;
  hash: string;
  status: 'inserted' | 'unchanged' | 'dry-run';
};

// sql.json()에 넘기려면 인덱스 시그니처 호환이 필요해서 interface 대신 type으로 둔다
type RunStats = {
  commit: string | null;
  files: FileResult[];
};

export const hashContent = (content: string): string =>
  createHash('sha256').update(content).digest('hex');

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

const requireEnv = (key: string): string => {
  const value = process.env[key];
  if (!value) {
    throw new Error(`${key} 환경 변수가 없습니다 (.env.local 확인)`);
  }
  return value;
};

/** master의 최신 커밋 SHA. 실패하면 null을 돌려주고 master 기준으로 받는다 */
const fetchLatestCommit = async (): Promise<string | null> => {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${REPO}/commits/master`,
      {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/vnd.github.sha',
        },
      },
    );
    if (!res.ok) return null;
    const sha = (await res.text()).trim();
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
};

const fetchRawFile = async (ref: string, path: string): Promise<string> => {
  const res = await fetch(
    `https://raw.githubusercontent.com/${REPO}/${ref}/${path}`,
    { headers: { 'User-Agent': USER_AGENT } },
  );
  if (!res.ok) {
    throw new Error(`${path}: GitHub ${res.status} ${res.statusText}`);
  }
  return res.text();
};

const main = async () => {
  const dryRun = process.argv.includes('--dry-run');
  const commit = await fetchLatestCommit();
  const ref = commit ?? 'master';
  const stats: RunStats = { commit, files: [] };

  if (dryRun) {
    for (const [index, path] of FILES.entries()) {
      if (index > 0) await sleep(REQUEST_INTERVAL_MS);
      const content = await fetchRawFile(ref, path);
      stats.files.push({
        path,
        bytes: content.length,
        hash: hashContent(content).slice(0, 12),
        status: 'dry-run',
      });
    }
    console.log('[dry-run]', JSON.stringify(stats, null, 2));
    return;
  }

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
    values ('showdown', 'champions')
    returning id
  `;
  const runId = run.id;

  try {
    for (const [index, path] of FILES.entries()) {
      if (index > 0) await sleep(REQUEST_INTERVAL_MS);

      const content = await fetchRawFile(ref, path);
      const hash = hashContent(content);
      const inserted = await sql`
        insert into ingest.snapshot
          (run_id, source, page_key, entity_key, rev_id, content, content_hash)
        values
          (${runId}, 'showdown', ${path}, null, null, ${content}, ${hash})
        on conflict (source, page_key, content_hash) do nothing
        returning id
      `;

      stats.files.push({
        path,
        bytes: content.length,
        hash: hash.slice(0, 12),
        status: inserted.length > 0 ? 'inserted' : 'unchanged',
      });
    }

    // 커밋을 못 받았으면 어느 시점 데이터인지 추적이 안 되므로 partial로 남긴다
    const status = commit ? 'success' : 'partial';
    await sql`
      update ingest.run
      set status = ${status}, finished_at = now(), stats = ${sql.json(stats)}
      where id = ${runId}
    `;
    console.log(`[run ${runId}] ${status}`, JSON.stringify(stats, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update ingest.run
      set status = 'failed', finished_at = now(),
          stats = ${sql.json(stats)}, error = ${message}
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
