import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ServiceLogService } from './service-log.service';
import { safeStringify } from './safe-stringify';

/**
 * TypeORM's Logger interface only sees a query BEFORE it runs (see
 * TypeOrmWinstonLogger) — it has no hook for the result. To log "what came
 * back", we patch QueryRunner.prototype.query once, on the concrete driver
 * class TypeORM is actually using. Every QueryRunner instance TypeORM creates
 * afterwards (one per request/transaction) shares that prototype, so this
 * single patch covers every query — raw dataSource.query() calls, repository
 * .find()/.save(), and QueryBuilder — not just the ones in this codebase that
 * call dataSource.query() directly.
 */
let patched = false;

/**
 * ServiceLogService.record() persists a log entry by running
 * `INSERT INTO service_log ...` via dataSource.query() — which is itself a
 * query, so it flows back through this same patched wrapper. Without this
 * guard, logging a query's result triggers another record() call to log the
 * INSERT that just logged it, which triggers another, forever: each level
 * embeds the previous entry as a bind parameter, so the payload roughly
 * doubles every recursion until the connection pool is exhausted. Every
 * query service_log itself issues (insert, purge, lookup) references the
 * table by name, so filtering on that name breaks the cycle without needing
 * any shared mutable state that concurrent requests could stomp on.
 */
function touchesServiceLog(query: string): boolean {
  return /service_log/i.test(query);
}

function extractRows(result: unknown): { rows: unknown; rowCount?: number } {
  if (Array.isArray(result)) {
    return { rows: result, rowCount: result.length };
  }
  if (result && typeof result === 'object') {
    const structured = result as { records?: unknown[]; raw?: unknown };
    if (Array.isArray(structured.records)) {
      return { rows: structured, rowCount: structured.records.length };
    }
  }
  return { rows: result };
}

export async function patchQueryResultLogging(
  dataSource: DataSource,
  serviceLog: ServiceLogService,
): Promise<void> {
  if (patched) return;

  const logger = new Logger('TypeORM');
  const runner = dataSource.createQueryRunner();
  const proto = Object.getPrototypeOf(runner);
  try {
    await runner.release();
  } catch {
    /* best effort — connection may not have been acquired yet */
  }

  if (typeof proto.query !== 'function' || proto.__queryResultLoggingPatched) {
    return;
  }
  patched = true;
  proto.__queryResultLoggingPatched = true;

  const originalQuery = proto.query;

  proto.query = async function patchedQuery(this: unknown, ...args: unknown[]) {
    const [query, parameters] = args as [string, unknown[] | undefined];
    const start = Date.now();
    try {
      const result = await originalQuery.apply(this, args);
      const duration = Date.now() - start;
      const { rows, rowCount } = extractRows(result);

      logger.debug(
        safeStringify({ type: 'query_result', query, params: parameters, duration, rowCount, result: rows }),
      );

      if (!touchesServiceLog(query)) {
        void serviceLog.record({
          service: 'db-queries',
          level: 'info',
          action: 'QUERY',
          message: query,
          metadata: { params: parameters, duration, rowCount, result: rows },
        });
      }

      return result;
    } catch (err) {
      const duration = Date.now() - start;
      const message = err instanceof Error ? err.message : String(err);

      logger.error(
        safeStringify({ type: 'query_result_error', query, params: parameters, duration, error: message }),
      );

      if (!touchesServiceLog(query)) {
        void serviceLog.record({
          service: 'db-queries',
          level: 'error',
          action: 'QUERY_ERROR',
          message: query,
          metadata: { params: parameters, duration, error: message },
        });
      }

      throw err;
    }
  };
}
