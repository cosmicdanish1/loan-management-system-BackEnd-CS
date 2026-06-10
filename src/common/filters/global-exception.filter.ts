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

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const errorResponse = exception.getResponse();

      if (typeof errorResponse === 'object') {
        message = (errorResponse as any).message || exception.message;
        error = (errorResponse as any).error || exception.name;
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
    }

    // Skip noisy browser auto-requests
    if (request.url === '/favicon.ico') {
      response.status(status).json({ statusCode: status, error, message });
      return;
    }

    // 404s are expected misses — warn, not error
    if (status === HttpStatus.NOT_FOUND) {
      this.logger.warn(`${request.method} ${request.url} - ${status} - ${message}`);
    } else {
      this.logger.error(
        `${request.method} ${request.url} - ${status} - ${message}`,
        exception instanceof Error ? exception.stack : exception,
      );
    }

    const errorResponse = {
      statusCode: status,
      timestamp: new Date().toISOString(),
      path: request.url,
      method: request.method,
      error,
      message,
    };

    response.status(status).json(errorResponse);
  }
}
