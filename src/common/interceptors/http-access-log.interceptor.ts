import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Request, Response } from 'express';

@Injectable()
export class HttpAccessLogInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HttpAccess');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const ctx = context.switchToHttp();
    const req = ctx.getRequest<Request>();
    const res = ctx.getResponse<Response>();
    const start = Date.now();

    return next.handle().pipe(
      tap({
        next: () => {
          this.logRequest(req, res, start);
        },
        error: () => {
          this.logRequest(req, res, start);
        },
      }),
    );
  }

  private logRequest(req: Request, res: Response, start: number): void {
    const duration = Date.now() - start;
    const user = (req as any).user?.username || 'anonymous';

    this.logger.log(
      JSON.stringify({
        requestId: req.requestId,
        method: req.method,
        url: req.originalUrl,
        status: res.statusCode,
        duration,
        user,
        clientIP: req.ip || req.socket?.remoteAddress,
        userAgent: req.headers['user-agent']?.substring(0, 100),
      }),
    );
  }
}
