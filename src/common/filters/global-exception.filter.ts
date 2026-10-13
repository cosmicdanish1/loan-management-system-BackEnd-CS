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
import { AlertBridge } from '../../modules/alerts/alert-bridge';
import { clientInfoOf } from '../../modules/alerts/client-info';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

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
        if ((errorResponse as any).code) {
          extra = { code: (errorResponse as any).code, authAction: (errorResponse as any).authAction, authLabel: (errorResponse as any).authLabel };
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
      // Express/body-parser errors (413 payload too large, 400 malformed JSON) are not HttpExceptions
      // but carry their own 4xx status; reporting them as 500 hid the real cause from callers.
      const ownStatus = Number((exception as any).status ?? (exception as any).statusCode);
      if (Number.isInteger(ownStatus) && ownStatus >= 400 && ownStatus < 500) {
        status = ownStatus;
      }
    }

    this.alertTelegram(exception, request, status);

    // Log the error
    this.logger.error(
      `${request.method} ${request.url} - ${status} - ${message}`,
      exception instanceof Error ? exception.stack : exception,
    );

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error,
      message,
      ...extra,
    };

    response.status(status).json(errorResponse);
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

      if (status === HttpStatus.UNAUTHORIZED && request.method === 'POST' && /\/auth\/login$/.test(url)) {
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
