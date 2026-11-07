import { CallHandler, ExecutionContext, Injectable, NestInterceptor, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { MobileAuditService } from './mobile-audit.service';

export const MOBILE_AUDIT_KEY = 'mobileAuditEvent';

/** Mark a /mobile route to be written to the audit trail: @MobileAudit('STATEMENT_DOWNLOAD'). Unmarked routes are not audited. */
export const MobileAudit = (event: string) => SetMetadata(MOBILE_AUDIT_KEY, event);

@Injectable()
export class MobileAuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: MobileAuditService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const event = this.reflector.get<string | undefined>(MOBILE_AUDIT_KEY, context.getHandler());
    if (!event) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest();
    const res = http.getResponse();
    return next.handle().pipe(
      tap({
        next: () => void this.audit.log(this.audit.fromRequest(req, { event, result: 'OK', statusCode: res?.statusCode })),
        error: (err) =>
          void this.audit.log(
            this.audit.fromRequest(req, { event, result: 'FAIL', statusCode: err?.status ?? err?.getStatus?.() ?? 500 }),
          ),
      }),
    );
  }
}
