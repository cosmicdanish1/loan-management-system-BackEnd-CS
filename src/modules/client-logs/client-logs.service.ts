import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import { ServiceLogService } from '../../common/logging/service-log.service';
import { redactText } from '../../common/logging/redact';

/** Frontend logs bypass winston (they're written directly to file/DB), so they
 *  need their own pass through the same password/token/aadhaar/pan patterns
 *  before anything touches disk or Postgres — e.g. a failed login's request
 *  body still carries the plaintext password at this point. */
function redactData(data: unknown): unknown {
  if (data === undefined || data === null) return data;
  try {
    return JSON.parse(redactText(JSON.stringify(data)));
  } catch {
    return data;
  }
}

@Injectable()
export class ClientLogsService {
  private readonly logger = new Logger(ClientLogsService.name);
  private readonly logDir: string;

  constructor(
    private readonly configService: ConfigService,
    private readonly serviceLog: ServiceLogService,
  ) {
    this.logDir = path.join(
      this.configService.get('LOG_FILE_PATH', './logs'),
      'clients',
    );
    this.ensureDir();
  }

  private ensureDir(): void {
    try {
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }
    } catch (err) {
      this.logger.error(`Failed to create client logs directory: ${err}`);
    }
  }

  /** The correlation id of the API call a frontend log entry describes (set by rendererLogger.apiCall), if any. */
  private static requestIdOf(data: unknown): string | undefined {
    const id = data && typeof data === 'object' ? (data as { requestId?: unknown }).requestId : undefined;
    return typeof id === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(id) ? id : undefined;
  }

  /** Per-PC client logs used to grow forever (one file hit 212 MB). Past MAX_BYTES the file is shifted to .1/.2/.3
   *  and the oldest is dropped, so each hostname keeps roughly MAX_BYTES * (KEEP + 1) at most. */
  private async rotateIfNeeded(logFile: string): Promise<void> {
    const MAX_BYTES = (Number(this.configService.get('CLIENT_LOG_MAX_MB', 20)) || 20) * 1024 * 1024;
    const KEEP = 3;
    let size = 0;
    try {
      size = (await fs.promises.stat(logFile)).size;
    } catch {
      return; // no file yet
    }
    if (size < MAX_BYTES) return;
    await fs.promises.rm(`${logFile}.${KEEP}`, { force: true });
    for (let i = KEEP - 1; i >= 1; i--) {
      await fs.promises.rename(`${logFile}.${i}`, `${logFile}.${i + 1}`).catch(() => undefined);
    }
    await fs.promises.rename(logFile, `${logFile}.1`);
  }

  async writeClientLogs(
    hostname: string,
    entries: Array<{
      level: string;
      route: string;
      message: string;
      timestamp: string;
      data?: any;
    }>,
  ): Promise<void> {
    const safeHostname = hostname.replace(/[^a-zA-Z0-9._-]/g, '_');
    const logFile = path.join(this.logDir, `${safeHostname}.log`);

    const redacted = entries.map((e) => ({ ...e, data: redactData(e.data) }));

    const lines = redacted
      .map((e) => {
        const data = e.data ? ` ${JSON.stringify(e.data)}` : '';
        return `[${e.timestamp}] [${e.level}] [${e.route}] ${redactText(e.message)}${data}`;
      })
      .join('\n') + '\n';

    try {
      await this.rotateIfNeeded(logFile);
      await fs.promises.appendFile(logFile, lines, 'utf-8');
    } catch (err) {
      this.logger.error(`Failed to write client logs for ${safeHostname}: ${err}`);
    }

    // Mirror every entry into service_log so frontend activity is queryable
    // alongside backend events (same request_id tracing, same retention job).
    for (const e of redacted) {
      void this.serviceLog.record({
        service: 'client',
        level: e.level === 'error' ? 'error' : e.level === 'warn' ? 'warn' : 'info',
        action: e.route,
        requestId: ClientLogsService.requestIdOf(e.data),
        message: redactText(e.message),
        metadata: { hostname, ...(e.data && typeof e.data === 'object' ? e.data : { data: e.data }) },
      });
    }
  }
}
