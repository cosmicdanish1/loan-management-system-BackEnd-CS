import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { QueryFailedError } from 'typeorm';
import { ClsServiceManager } from 'nestjs-cls';
import { AlertBridge } from '../../modules/alerts/alert-bridge';
import { clientInfoOf } from '../../modules/alerts/client-info';
import { ServiceLogService } from '../logging/service-log.service';
import { safeStringify } from '../logging/safe-stringify';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);
  private readonly accessLogger = new Logger('HttpAccess');

  /** serviceLog is optional so `new GlobalExceptionFilter()` (unit tests) still works; main.ts passes the real one. */
  constructor(private readonly serviceLog?: ServiceLogService) {}

  /** Text that only makes sense to a developer: SQL / driver errors and JavaScript runtime errors. */
  private static readonly TECHNICAL =
    /null value in column|violates (not-null|foreign key|unique|check)|relation "|column "[^"]+"|invalid input syntax|syntax error at|duplicate key value|Cannot read propert|Cannot set propert|is not iterable|is not a function|is not defined|undefined \(reading|\bECONN|\bETIMEDOUT|out of range for type|Unexpected token|at (async )?[A-Za-z_.]+ \(/i;

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let error = 'Internal Server Error';
    // Machine-readable extras some exceptions carry (e.g. the authenticator-code guard's AUTH_CODE_REQUIRED)
    let extra: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const errorResponse = exception.getResponse();

      if (typeof errorResponse === 'object') {
        message = (errorResponse as any).message || exception.message;
        error = (errorResponse as any).error || exception.name;
        // field-by-field problems of a failed validation (ES-468): [{ field, label, code, message, params }]
        if (Array.isArray((errorResponse as any).errors)) extra.errors = (errorResponse as any).errors;
        if ((errorResponse as any).params && typeof (errorResponse as any).params === 'object') extra.params = (errorResponse as any).params;
        if ((errorResponse as any).code) {
          extra = { ...extra, code: (errorResponse as any).code, authAction: (errorResponse as any).authAction, authLabel: (errorResponse as any).authLabel };
          // Member-app (mobile) machine-readable extras: wrong-MPIN tries left, wait time, the action an App Code approval is needed for.
          for (const k of ['attemptsLeft', 'retryAfterSeconds', 'action']) {
            if ((errorResponse as any)[k] !== undefined) extra[k] = (errorResponse as any)[k];
          }
        }
      } else {
        message = errorResponse;
        error = exception.name;
      }
    } else if (exception instanceof QueryFailedError) {
      status = HttpStatus.BAD_REQUEST;
      message = 'Database operation failed';
      error = 'Database Error';

      // Handle specific database errors
      if (exception.message.includes('duplicate key')) {
        message = 'Record already exists';
        status = HttpStatus.CONFLICT;
      } else if (exception.message.includes('foreign key')) {
        message = 'Referenced record not found';
        status = HttpStatus.BAD_REQUEST;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      error = exception.name;
      // Database and JavaScript internals (table/column names, "Cannot read properties of undefined") are for the
      // server log, never for the person using the screen (ES-302). The full text is still logged below.
      if (GlobalExceptionFilter.TECHNICAL.test(exception.message)) {
        const rid = GlobalExceptionFilter.requestIdOf(request);
        const ref = rid ? ` (reference ${rid})` : '';
        message = `Something went wrong on the server while handling this request${ref}. Please check what you entered and try again. If it keeps happening, tell support.`;
        error = 'Internal Server Error';
      }
      // Express/body-parser errors (413 payload too large, 400 malformed JSON) are not HttpExceptions
      // but carry their own 4xx status; reporting them as 500 hid the real cause from callers.
      const ownStatus = Number((exception as any).status ?? (exception as any).statusCode);
      if (Number.isInteger(ownStatus) && ownStatus >= 400 && ownStatus < 500) {
        status = ownStatus;
      }
    }

    // Every error carries a stable `code` the screen can translate (ES-286); a specific code set above wins.
    if (extra.code === undefined) extra.code = GlobalExceptionFilter.defaultCodeFor(status);

    this.alertTelegram(exception, request, status);
    this.logRejectedCall(request, status, message);

    // Log the error. A handled client error (validation, not found, conflict, refused request) is normal
    // traffic: warn level, one line, no stack trace. Only server faults (5xx) and failed SQL (which is mapped
    // to a 4xx for the caller but is really a fault) keep ERROR with the stack. (ES-331)
    const logLine = `${request.method} ${request.url} - ${status} - ${Array.isArray(message) ? message.join('; ') : message}`;
    const isClientError = status >= 400 && status < 500 && !(exception instanceof QueryFailedError);
    if (isClientError) {
      this.logger.warn(logLine);
    } else {
      this.logger.error(logLine, exception instanceof Error ? exception.stack : exception);
    }

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error,
      message,
      // Same id the screen sent as X-Request-Id and the server wrote on every log line of this request: the
      // screen shows it in small grey text so support can find the exact log line (ES-444).
      ...(GlobalExceptionFilter.requestIdOf(request) ? { requestId: GlobalExceptionFilter.requestIdOf(request) } : {}),
      ...extra,
    };

    response.status(status).json(errorResponse);
  }

  /** Calls rejected before they reach the access-log interceptor (guard 401/403, unknown route, body-parser errors)
   *  have no access-log line. Write one here so a failed login or an expired session is visible in http-access and
   *  in service_log. Calls that did reach the interceptor are flagged and skipped. Never throws; no request body is
   *  logged (a failed login body holds the password). */
  private logRejectedCall(request: Request, status: number, message: unknown): void {
    try {
      if (!request || (request as any).accessLogged) return;
      const entry = {
        requestId: GlobalExceptionFilter.requestIdOf(request),
        method: request.method,
        url: request.originalUrl || request.url,
        status,
        user: (request as any).user?.username || 'anonymous',
        clientIP: request.ip || request.socket?.remoteAddress,
        userAgent: String(request.headers?.['user-agent'] ?? '').substring(0, 100),
        requestQuery: request.query,
        rejectedBeforeController: true,
        error: Array.isArray(message) ? message.join('; ') : String(message),
      };
      this.accessLogger.warn(safeStringify(entry));
      void this.serviceLog?.record({
        service: 'api',
        level: status >= 500 ? 'error' : 'warn',
        action: `${request.method} ${request.originalUrl || request.url}`.substring(0, 80),
        message: entry.url,
        userId: (request as any).user?.id,
        metadata: { status, user: entry.user, clientIP: entry.clientIP, requestQuery: entry.requestQuery, rejectedBeforeController: true, error: entry.error },
      });
    } catch { /* logging must never break error handling */ }
  }

  /** Stable code for an error that did not name one, from its HTTP status. */
  static defaultCodeFor(status: number): string {
    const map: Record<number, string> = {
      400: 'BAD_REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT',
      410: 'GONE', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE', 422: 'UNPROCESSABLE', 429: 'TOO_MANY_REQUESTS',
    };
    return map[status] ?? (status >= 500 ? 'SERVER_ERROR' : 'ERROR');
  }

  /** The correlation id of this request: the one the screen sent in X-Request-Id, else the one the server made. */
  private static requestIdOf(request: Request): string | undefined {
    try {
      const id = ClsServiceManager.getClsService().getId() || (request as any).requestId;
      return id ? String(id) : undefined;
    } catch {
      return (request as any).requestId ? String((request as any).requestId) : undefined;
    }
  }

  /** Telegram alerts for failed logins and server-side errors. Never throws. */
  private alertTelegram(exception: unknown, request: Request, status: number): void {
    try {
      const alerts = AlertBridge.get();
      if (!alerts) return;
      const url = (request.originalUrl || request.url || '').split('?')[0];
      const route = (request as any).route?.path || url.replace(/\/\d+(?=\/|$)/g, '/:id');
      const user = (request as any).user?.username;
      const requestId = (request as any).requestId;

      // (member-app logins under /mobile/ are recorded in mobile_audit_log, not in the staff Telegram alert)
      if (status === HttpStatus.UNAUTHORIZED && request.method === 'POST' && /\/auth\/login$/.test(url) && !/\/mobile\//.test(url)) {
        alerts.loginFailed({ username: String((request.body as any)?.username ?? ''), client: clientInfoOf(request) });
        return;
      }
      // Errors from Express/body-parser (e.g. 413 payload too large) carry their own 4xx status
      // but are not HttpExceptions, so this filter maps them to 500. They are the caller's
      // fault, not a server failure, so they are not alerted.
      const ownStatus = (exception as any)?.status ?? (exception as any)?.statusCode;
      if (typeof ownStatus === 'number' && ownStatus >= 400 && ownStatus < 500) return;
      if (exception instanceof QueryFailedError) {
        // Duplicate/foreign-key errors are normal business rejections and can echo record values.
        if (/duplicate key|foreign key/i.test(exception.message)) return;
        alerts.reportServerError({
          method: request.method, route, status: 500, user, requestId,
          message: exception.message.replace(/Key \(.*?\)=\(.*?\)/g, 'Key (…)'),
        });
        return;
      }
      if (status >= 500) {
        alerts.reportServerError({
          method: request.method, route, status, user, requestId,
          message: exception instanceof Error ? exception.message : String(exception),
        });
      }
    } catch { /* alerting must never break error handling */ }
  }
}
