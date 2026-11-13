import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';
import { ServiceLogService } from '../logging/service-log.service';
import { safeStringify } from '../logging/safe-stringify';

/** Largest request/response body (in characters of JSON) written to a log line. A full report response is often
 *  hundreds of KB: logging it whole made 191 calls produce ~37 MB of logs. Bigger bodies keep a short preview and
 *  their size, which is enough to tell what was returned; the data itself is in the database. */
const BODY_MAX_CHARS = Math.max(500, Number(process.env.LOG_BODY_MAX_CHARS) || 4000);
const PREVIEW_CHARS = 1000;

export function clipBody(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  const json = safeStringify(value);
  if (json.length <= BODY_MAX_CHARS) return value;
  return { _truncated: true, chars: json.length, preview: json.slice(0, PREVIEW_CHARS) };
}

@Injectable()
export class HttpAccessLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpAccess');

  constructor(private readonly serviceLog: ServiceLogService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: (body) => {
          this.logRequest(req, res, start, body);
        },
        error: (err) => {
          this.logRequest(req, res, start, undefined, err);
        },
      }),
    );
  }

  private logRequest(req: Request, res: Response, start: number, responseBody?: unknown, error?: unknown): void {
    const duration = Date.now() - start;
    const user = (req as any).user?.username || 'anonymous';
    const isFile = responseBody instanceof StreamableFile;
    // Tell GlobalExceptionFilter this request already has an access-log line, so it only adds one for calls that
    // were rejected before reaching an interceptor (guard 401/403, unknown route) and never writes a duplicate.
    (req as any).accessLogged = true;
    const requestBody = clipBody(req.body);
    const response = isFile ? '[file stream]' : clipBody(responseBody);

    const entry = {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      user,
      clientIP: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent']?.substring(0, 100),
      requestBody,
      requestQuery: req.query,
      response,
      error: error instanceof Error ? error.message : error,
    };

    // File — full detail, JSON.stringify so redactFormat scrubs password/token/etc.
    if (error) {
      this.logger.error(safeStringify(entry));
    } else {
      this.logger.log(safeStringify(entry));
    }

    // service_log DB row — one per API call.
    void this.serviceLog.record({
      service: 'api',
      level: error || res.statusCode >= 400 ? (res.statusCode >= 500 || error ? 'error' : 'warn') : 'info',
      action: `${req.method} ${req.route?.path || req.originalUrl}`,
      message: req.originalUrl,
      userId: (req as any).user?.id,
      metadata: {
        status: res.statusCode,
        duration,
        user,
        clientIP: req.ip || req.socket?.remoteAddress,
        requestBody,
        requestQuery: req.query,
        response,
        error: error instanceof Error ? error.message : error,
      },
    });
  }
}
