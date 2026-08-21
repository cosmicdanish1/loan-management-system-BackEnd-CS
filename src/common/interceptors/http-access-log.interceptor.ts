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

    const entry = {
      requestId: req.requestId,
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration,
      user,
      clientIP: req.ip || req.socket?.remoteAddress,
      userAgent: req.headers['user-agent']?.substring(0, 100),
      requestBody: req.body,
      requestQuery: req.query,
      response: isFile ? '[file stream]' : responseBody,
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
        requestBody: req.body,
        requestQuery: req.query,
        response: isFile ? '[file stream]' : responseBody,
        error: error instanceof Error ? error.message : error,
      },
    });
  }
}
