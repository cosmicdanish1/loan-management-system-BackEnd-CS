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
        message: redactText(e.message),
        metadata: { hostname, ...(e.data && typeof e.data === 'object' ? e.data : { data: e.data }) },
      });
    }
  }
}
