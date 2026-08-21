import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { ClsServiceManager } from 'nestjs-cls';
import { DOMAIN_FILES } from './logging.config';
import { redactText } from './redact';

/** record() inserts via raw SQL, bypassing winston's redactFormat entirely —
 *  apply the same password/token/aadhaar/pan patterns here so a login request
 *  body or a query result touching a token column never lands in Postgres
 *  in plaintext. */
function redactValue<T>(value: T): T {
  if (value === undefined || value === null) return value;
  try {
    return JSON.parse(redactText(JSON.stringify(value)));
  } catch {
    return value;
  }
}

export type ServiceLogLevel = 'info' | 'warn' | 'error';

export interface ServiceLogEntry {
  /** Service/domain this event belongs to (one of DOMAIN_FILES). Unknown values
   *  land in the DEFAULT partition (service_log_other) — the insert never fails. */
  service: string;
  level?: ServiceLogLevel;
  action?: string;
  message?: string;
  userId?: number;
  metadata?: Record<string, unknown>;
}

/** Total size budget across every service_log* partition. Once exceeded, the
 *  oldest rows (by created_at) are deleted until back under budget — no age
 *  limit; a row lives indefinitely as long as total size stays under this. */
const MAX_TOTAL_BYTES = 1 * 1024 ** 3; // 1GB
const DELETE_BATCH_SIZE = 500;
const MAX_BATCHES_PER_RUN = 200; // safety cap: up to 100k rows purged per run

/**
 * Structured, per-service event log persisted to Postgres.
 *
 * Design (see the logging/tracing plan):
 *  - ONE table `service_log`, LIST-partitioned by `service`, with a physical
 *    child table per domain (service_log_auth, service_log_loan, ...). This gives
 *    per-service segregation AND single-query cross-service tracing by request_id.
 *  - Only structured EVENTS go here (logins, loan approved, errors) — not the
 *    verbose diagnostic/SQL logs, which stay in the rotating winston files.
 *  - request_id is auto-filled from the CLS context so every event ties into the
 *    same correlation id used by the file logs.
 */
@Injectable()
export class ServiceLogService implements OnModuleInit {
  private readonly logger = new Logger('ServiceLog');
  private ready = false;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    await this.ensureSchema();
  }

  /** Sanitize a domain into a safe partition table name (e.g. 'day-end' -> service_log_day_end). */
  private partitionName(service: string): string {
    return 'service_log_' + service.replace(/[^a-z0-9]+/gi, '_').toLowerCase();
  }

  /** Idempotently create the partitioned parent + per-service partitions + indexes.
   *  Matches the repo convention of ensuring tables on boot (cf. BackupService). */
  private async ensureSchema(): Promise<void> {
    try {
      await this.dataSource.query(`
        CREATE TABLE IF NOT EXISTS service_log (
          id          BIGSERIAL,
          service     VARCHAR(40)  NOT NULL,
          level       VARCHAR(10)  NOT NULL DEFAULT 'info',
          request_id  VARCHAR(64),
          user_id     INTEGER,
          action      VARCHAR(80),
          message     TEXT,
          metadata    JSONB,
          created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
          PRIMARY KEY (id, service)
        ) PARTITION BY LIST (service);
      `);

      // One physical child table per domain. DOMAIN_FILES is a trusted constant,
      // so inlining the value is safe (partition DDL cannot be parameterized).
      for (const domain of DOMAIN_FILES) {
        await this.dataSource.query(
          `CREATE TABLE IF NOT EXISTS ${this.partitionName(domain)} ` +
            `PARTITION OF service_log FOR VALUES IN ('${domain}');`,
        );
      }

      // Catch-all so an unmapped service never breaks an insert.
      await this.dataSource.query(
        `CREATE TABLE IF NOT EXISTS service_log_other PARTITION OF service_log DEFAULT;`,
      );

      // Indexes for the two query paths: per-service browsing and cross-service trace.
      await this.dataSource.query(
        `CREATE INDEX IF NOT EXISTS idx_service_log_svc_time ON service_log (service, created_at DESC);`,
      );
      await this.dataSource.query(
        `CREATE INDEX IF NOT EXISTS idx_service_log_reqid ON service_log (request_id);`,
      );

      this.ready = true;
      this.logger.log('service_log table + per-service partitions ready');
    } catch (err) {
      this.logger.error(`Failed to ensure service_log schema: ${(err as Error).message}`);
    }
  }

  private currentRequestId(): string | undefined {
    try {
      return ClsServiceManager.getClsService().getId();
    } catch {
      return undefined;
    }
  }

  /**
   * Record one structured event. Fire-and-forget safe: never throws, never blocks
   * the request — a logging failure must not break business logic.
   */
  async record(entry: ServiceLogEntry): Promise<void> {
    if (!this.ready) return; // schema not ready yet (very early boot) — skip
    try {
      await this.dataSource.query(
        `INSERT INTO service_log (service, level, request_id, user_id, action, message, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          entry.service || 'other',
          entry.level ?? 'info',
          this.currentRequestId() ?? null,
          entry.userId ?? null,
          entry.action ?? null,
          entry.message ? redactText(entry.message) : null,
          entry.metadata ? JSON.stringify(redactValue(entry.metadata)) : null,
        ],
      );
    } catch (err) {
      this.logger.error(`service_log insert failed: ${(err as Error).message}`);
    }
  }

  /** All events for one request, across every service — the cross-service trace. */
  async findByRequestId(requestId: string): Promise<Record<string, unknown>[]> {
    return this.dataSource.query(
      `SELECT * FROM service_log WHERE request_id = $1 ORDER BY created_at ASC`,
      [requestId],
    );
  }

  /** Recent events, optionally scoped to one service. */
  async findRecent(service?: string, limit = 100): Promise<Record<string, unknown>[]> {
    if (service) {
      return this.dataSource.query(
        `SELECT * FROM service_log WHERE service = $1 ORDER BY created_at DESC LIMIT $2`,
        [service, limit],
      );
    }
    return this.dataSource.query(
      `SELECT * FROM service_log ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
  }

  /** Total on-disk size across every service_log* partition (table + indexes). */
  private async currentSizeBytes(): Promise<number> {
    const res = await this.dataSource.query(
      `SELECT COALESCE(SUM(pg_total_relation_size(quote_ident(table_name))), 0)::bigint AS bytes
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name LIKE 'service_log%'`,
    );
    return Number(res[0].bytes);
  }

  /** Hourly — once total size exceeds MAX_TOTAL_BYTES, delete the oldest rows
   *  (across every partition, by created_at) in batches until back under
   *  budget. id alone isn't unique across partitions — the table's primary
   *  key is (id, service) — so both are selected and matched on delete. */
  @Cron('11 * * * *') // hourly
  async enforceStorageBudget(): Promise<void> {
    if (!this.ready) return;
    try {
      let totalBytes = await this.currentSizeBytes();
      if (totalBytes <= MAX_TOTAL_BYTES) return;

      let deletedRows = 0;
      let batches = 0;
      while (totalBytes > MAX_TOTAL_BYTES && batches < MAX_BATCHES_PER_RUN) {
        const deleted = await this.dataSource.query(
          `DELETE FROM service_log
           WHERE (id, service) IN (
             SELECT id, service FROM service_log ORDER BY created_at ASC LIMIT $1
           )
           RETURNING id`,
          [DELETE_BATCH_SIZE],
        );
        const batchDeleted = deleted?.length ?? 0;
        deletedRows += batchDeleted;
        batches++;
        if (batchDeleted < DELETE_BATCH_SIZE) break; // table's now empty, nothing left to delete

        totalBytes = await this.currentSizeBytes();
      }

      if (deletedRows > 0) {
        this.logger.log(
          `service_log storage budget sweep: deleted ${deletedRows} oldest row(s) across ${batches} batch(es). ` +
            `Size now ~${(totalBytes / 1024 ** 2).toFixed(1)}MB (budget ${(MAX_TOTAL_BYTES / 1024 ** 3).toFixed(1)}GB).`,
        );
      }
      if (batches >= MAX_BATCHES_PER_RUN && totalBytes > MAX_TOTAL_BYTES) {
        this.logger.warn(
          `service_log still over budget after ${MAX_BATCHES_PER_RUN} batches this run — will continue next hour.`,
        );
      }
    } catch (err) {
      this.logger.error(`service_log storage budget sweep failed: ${(err as Error).message}`);
    }
  }
}
