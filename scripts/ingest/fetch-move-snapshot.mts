/**
 * Bulbapedia 기술 문서 원문(wikitext)을 ingest.snapshot에 저장한다.
 *
 * - public 스키마는 읽기만 한다. ingest_bot 역할에 public 쓰기 권한이 없어서
 *   코드에 실수가 있어도 DB가 거부한다.
 * - 같은 페이지의 같은 내용은 다시 저장하지 않는다 (source, page_key, content_hash 유니크).
 * - 파싱·제안 생성은 하지 않는다. 원문 보관만 하는 1단계 스크립트.
 * - Bulbapedia가 바쁘다고 응답하면(503 등) 기다렸다가 다시 시도한다.
 *
 * 실행 (기술 id 범위):
 *   node --env-file=.env.local scripts/ingest/fetch-move-snapshot.mts 1 902
 *   node --env-file=.env.local scripts/ingest/fetch-move-snapshot.mts 1 902 --missing-only
 *     (--missing-only: 아직 원문이 하나도 없는 기술만 받는다. 중단된 수집을 이어받을 때)
 *   node --env-file=.env.local scripts/ingest/fetch-move-snapshot.mts --changed-only
 *     (--changed-only: 판 번호만 먼저 묻고, 저장된 최신 판과 다른 문서만 원문을 받는다.
 *      매일 자동 수집용. id를 생략하면 전체 기술)
 *
 * 필요한 환경 변수 (.env.local):
 *   INGEST_DB_HOST      Supabase Connect > Session pooler 의 host
 *   INGEST_DB_PASSWORD  ingest_bot 비밀번호
 */
import { createHash } from 'node:crypto';
import postgres from 'postgres';

const PROJECT_REF = 'gdveyihxwjemujyhpgzy';
// 테스트에서만 바꾼다
const API_URL =
  process.env.BULBAPEDIA_API_URL ?? 'https://bulbapedia.bulbagarden.net/w/api.php';
const USER_AGENT =
  'poke-mumu-ingest/0.1 (+https://github.com/jomoo02/poke-mumu)';

// 한 요청에 받는 문서 수. 원문 전체를 받으므로 응답이 커지지 않게 작게 유지한다
const BATCH_SIZE = 20;
// 판 번호만 물을 때 한 요청에 넣는 문서 수 (MediaWiki titles 상한)
const REV_ID_BATCH_SIZE = 50;
// 요청 사이 대기 시간
const REQUEST_INTERVAL_MS = 2000;

// 서버가 바쁠 때 다시 시도하는 규칙
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 5000; // 5초, 10초, 20초, 40초
const MAX_BACKOFF_MS = 60000;

interface MoveRow {
  id: number;
  identifier: string;
  name_en: string | null;
}

interface WikiRevision {
  revid: number;
  timestamp: string;
  slots: { main: { content: string } };
}

interface WikiPage {
  title: string;
  missing?: boolean;
  invalid?: boolean;
  revisions?: WikiRevision[];
}

interface WikiTitleMapping {
  from: string;
  to: string;
}

interface WikiResponse {
  query?: {
    pages?: WikiPage[];
    normalized?: WikiTitleMapping[];
    redirects?: WikiTitleMapping[];
  };
  error?: { code: string; info: string };
}

// sql.json()에 넘기려면 인덱스 시그니처 호환이 필요해서 interface 대신 type으로 둔다
type RunStats = {
  requested: number;
  skippedExisting: number;
  skippedSameRevision: number;
  inserted: number;
  unchanged: number;
  retries: number;
  noEnglishName: string[];
  missingPage: string[];
  redirected: string[];
};

// DB 영어 이름은 둥근 따옴표(King’s Shield), Bulbapedia 문서 제목은 곧은 따옴표(King's Shield)
export const toMoveTitle = (nameEn: string): string =>
  `${nameEn.replace(/[‘’]/g, "'")} (move)`;

/**
 * 요청한 제목이 응답에서 어떤 실제 페이지로 이어졌는지 따라간다.
 * 순서: 정규화(공백·대소문자) → 리다이렉트(옛 이름 → 현재 이름)
 */
export const resolveTitle = (
  requested: string,
  query: NonNullable<WikiResponse['query']>,
): string => {
  const normalized =
    query.normalized?.find((m) => m.from === requested)?.to ?? requested;
  return query.redirects?.find((m) => m.from === normalized)?.to ?? normalized;
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

type Args = { from: number; to: number; missingOnly: boolean; changedOnly: boolean };

const USAGE =
  '사용법: fetch-move-snapshot.mts [<시작 id> [끝 id]] [--missing-only | --changed-only]\n' +
  '  id를 생략하면 전체 기술';

export const parseArgs = (args: string[]): Args => {
  const missingOnly = args.includes('--missing-only');
  const changedOnly = args.includes('--changed-only');
  if (missingOnly && changedOnly) throw new Error(USAGE);

  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length === 0) {
    return { from: 1, to: Number.MAX_SAFE_INTEGER, missingOnly, changedOnly };
  }
  const [fromArg, toArg = fromArg] = positional;
  const from = Number(fromArg);
  const to = Number(toArg);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || from > to) {
    throw new Error(USAGE);
  }
  return { from, to, missingOnly, changedOnly };
};

const scopeLabel = ({ from, to, missingOnly, changedOnly }: Args): string => {
  const range = to === Number.MAX_SAFE_INTEGER ? 'all' : `${from}-${to}`;
  const mode = missingOnly ? ' missing-only' : changedOnly ? ' changed-only' : '';
  return `move:${range}${mode}`;
};

/** 서버가 알려준 대기 시간(초). 없으면 null */
const retryAfterMs = (res: Response): number | null => {
  const seconds = Number(res.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
};

type RetryHandler = (reason: string, waitMs: number, attempt: number) => void;

export const fetchRevisions = (titles: string[], onRetry: RetryHandler): Promise<WikiResponse> =>
  requestRevisions(titles, 'ids|timestamp|content', onRetry);

/**
 * 원문 없이 최신 판 번호만 받는다. 바뀐 문서만 원문을 받을 때 먼저 쓴다.
 * 응답이 작아서 한 번에 50개까지 묻는다 (MediaWiki titles 상한).
 */
export const fetchLatestRevIds = async (
  titles: string[],
  onRetry: RetryHandler,
): Promise<Map<string, number | null>> => {
  const result = new Map<string, number | null>();
  for (let i = 0; i < titles.length; i += REV_ID_BATCH_SIZE) {
    if (i > 0) await sleep(REQUEST_INTERVAL_MS);
    const batch = titles.slice(i, i + REV_ID_BATCH_SIZE);
    const { query } = await requestRevisions(batch, 'ids', onRetry);
    if (!query?.pages) {
      throw new Error('Bulbapedia API 응답에 pages가 없습니다');
    }
    const pageByTitle = new Map(query.pages.map((page) => [page.title, page]));
    for (const title of batch) {
      const page = pageByTitle.get(resolveTitle(title, query));
      result.set(title, page?.revisions?.[0]?.revid ?? null);
    }
  }
  return result;
};

const requestRevisions = async (
  titles: string[],
  rvprop: 'ids' | 'ids|timestamp|content',
  onRetry: RetryHandler,
): Promise<WikiResponse> => {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'revisions',
    rvprop,
    redirects: '1',
    format: 'json',
    formatversion: '2',
    // 서버가 바쁠 때(복제 지연 5초 초과) 요청을 거절받도록 한다
    maxlag: '5',
    titles: titles.join('|'),
  });
  if (rvprop !== 'ids') params.set('rvslots', 'main');

  for (let attempt = 1; ; attempt += 1) {
    const res = await fetch(`${API_URL}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
    });

    let reason: string;
    if (RETRYABLE_STATUS.has(res.status)) {
      reason = `HTTP ${res.status}`;
      await res.body?.cancel();
    } else if (!res.ok) {
      throw new Error(`Bulbapedia API ${res.status} ${res.statusText}`);
    } else {
      const body = (await res.json()) as WikiResponse;
      if (body.error?.code === 'maxlag') {
        reason = 'maxlag';
      } else if (body.error) {
        throw new Error(`Bulbapedia API ${body.error.code}: ${body.error.info}`);
      } else {
        return body;
      }
    }

    if (attempt >= MAX_ATTEMPTS) {
      throw new Error(`Bulbapedia API ${reason} (${attempt}회 시도 후 중단)`);
    }
    const waitMs = Math.min(
      retryAfterMs(res) ?? BASE_BACKOFF_MS * 2 ** (attempt - 1),
      MAX_BACKOFF_MS,
    );
    onRetry(reason, waitMs, attempt);
    await sleep(waitMs);
  }
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const { from, to, missingOnly, changedOnly } = args;

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

  const stats: RunStats = {
    requested: 0,
    skippedExisting: 0,
    skippedSameRevision: 0,
    inserted: 0,
    unchanged: 0,
    retries: 0,
    noEnglishName: [],
    missingPage: [],
    redirected: [],
  };

  const [run] = await sql<{ id: number }[]>`
    insert into ingest.run (source, scope)
    values ('bulbapedia', ${scopeLabel(args)})
    returning id
  `;
  const runId = run.id;

  const onRetry: RetryHandler = (reason, waitMs, attempt) => {
    stats.retries += 1;
    console.warn(
      `  ${reason} → ${Math.round(waitMs / 1000)}초 후 다시 시도 (${attempt}/${MAX_ATTEMPTS - 1})`,
    );
  };

  try {
    // bigint는 문자열로 오므로 ::int로 받는다
    const moves = await sql<(MoveRow & { latest_rev_id: number | null })[]>`
      select m.id::int, m.identifier, m.name_en,
             (select s.rev_id::int from ingest.snapshot s
              where s.source = 'bulbapedia' and s.entity_key = 'move:' || m.id
              order by s.fetched_at desc limit 1) as latest_rev_id
      from public.move m
      where m.id between ${from} and ${to}
      order by m.id
    `;
    stats.requested = moves.length;

    let targets = moves.filter((move) => {
      if (missingOnly && move.latest_rev_id !== null) {
        stats.skippedExisting += 1;
        return false;
      }
      if (move.name_en) return true;
      stats.noEnglishName.push(move.identifier);
      return false;
    });

    // 판 번호가 저장된 최신 판과 같은 문서는 원문을 받지 않는다
    if (changedOnly) {
      const revIds = await fetchLatestRevIds(
        targets.map((move) => toMoveTitle(move.name_en ?? '')),
        onRetry,
      );
      targets = targets.filter((move) => {
        const revId = revIds.get(toMoveTitle(move.name_en ?? ''));
        if (revId !== null && revId !== undefined && revId === move.latest_rev_id) {
          stats.skippedSameRevision += 1;
          return false;
        }
        return true;
      });
      console.log(`  판 번호 확인: ${moves.length}개 중 바뀐 문서 ${targets.length}개`);
    }

    for (let i = 0; i < targets.length; i += BATCH_SIZE) {
      if (i > 0) await sleep(REQUEST_INTERVAL_MS);

      const batch = targets.slice(i, i + BATCH_SIZE);
      const titles = batch.map((move) => toMoveTitle(move.name_en ?? ''));
      const { query } = await fetchRevisions(titles, onRetry);
      if (!query?.pages) {
        throw new Error('Bulbapedia API 응답에 pages가 없습니다');
      }

      const pageByTitle = new Map(query.pages.map((page) => [page.title, page]));

      for (const [index, move] of batch.entries()) {
        const requested = titles[index];
        const resolved = resolveTitle(requested, query);
        const page = pageByTitle.get(resolved);
        const revision = page?.revisions?.[0];

        if (!page || page.missing || page.invalid || !revision) {
          stats.missingPage.push(`${move.identifier} (${requested})`);
          continue;
        }
        if (resolved !== requested) {
          stats.redirected.push(`${requested} → ${resolved}`);
        }

        const content = revision.slots.main.content;
        const inserted = await sql`
          insert into ingest.snapshot
            (run_id, source, page_key, entity_key, rev_id, content, content_hash)
          values
            (${runId}, 'bulbapedia', ${resolved}, ${`move:${move.id}`},
             ${revision.revid}, ${content}, ${hashContent(content)})
          on conflict (source, page_key, content_hash) do nothing
          returning id
        `;

        if (inserted.length > 0) stats.inserted += 1;
        else stats.unchanged += 1;
      }

      const done = Math.min(i + BATCH_SIZE, targets.length);
      console.log(`  ${done}/${targets.length} (저장 ${stats.inserted}, 변경 없음 ${stats.unchanged})`);
    }

    const status =
      stats.missingPage.length > 0 || stats.noEnglishName.length > 0
        ? 'partial'
        : 'success';

    await sql`
      update ingest.run
      set status = ${status}, finished_at = now(), stats = ${sql.json(stats)}
      where id = ${runId}
    `;
    console.log(`[run ${runId}] ${status}`, stats);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sql`
      update ingest.run
      set status = 'failed', finished_at = now(),
          stats = ${sql.json(stats)}, error = ${message}
      where id = ${runId}
    `;
    console.error(`[run ${runId}] failed: ${message}`);
    console.error('  저장된 원문은 남아 있습니다. --missing-only로 이어받을 수 있어요');
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
};

// 테스트에서 import할 때는 실행하지 않는다
if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
