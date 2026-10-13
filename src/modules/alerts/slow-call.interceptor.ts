import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { finalize } from 'rxjs/operators';
import { AlertBridge } from './alert-bridge';

// Long-running jobs that are slow by design are not worth an alert.
const SLOW_EXEMPT = /backup|restore|day-?end|migrat|import|export|generate|interest|consolidat/i;

/**
 * Times every HTTP request and reports the slow ones to Telegram (threshold SLOW_API_MS,
 * default 5000). Independent of the access-log interceptor, which is not registered.
 */
@Injectable()
export class SlowCallInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        if (context.getType() !== 'http') return next.handle();
        const start = Date.now();
        const req: any = context.switchToHttp().getRequest();
        return next.handle().pipe(
            finalize(() => {
                try {
                    const ms = Date.now() - start;
                    const limit = AlertBridge.get()?.slowThresholdMs() ?? (Number(process.env.SLOW_API_MS) || 5000);
                    if (ms < limit) return;
                    const urlPath = String(req.originalUrl || '').split('?')[0];
                    if (SLOW_EXEMPT.test(urlPath)) return;
                    AlertBridge.get()?.reportSlowCall({
                        method: req.method,
                        route: req.route?.path || urlPath.replace(/\/\d+(?=\/|$)/g, '/:id'),
                        ms,
                        user: req.user?.username,
                    });
                } catch { /* alerting must never affect a request */ }
            }),
        );
    }
}
