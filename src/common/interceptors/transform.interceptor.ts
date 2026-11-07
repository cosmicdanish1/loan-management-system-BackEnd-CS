import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Stream } from 'stream';

export interface Response<T> {
  success: boolean;
  statusCode: number;
  message: string;
  data: T;
  timestamp: string;
}

/** A file or binary payload must reach the client byte for byte, never inside the JSON envelope. (ES-373) */
function isBinaryPayload(data: unknown): boolean {
  return data instanceof StreamableFile || Buffer.isBuffer(data) || data instanceof Stream;
}

@Injectable()
export class TransformInterceptor<T>
  implements NestInterceptor<T, Response<T>>
{
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<Response<T>> {
    const ctx = context.switchToHttp();
    const response = ctx.getResponse();

    return next.handle().pipe(
      map((data) => {
        if (isBinaryPayload(data)) return data as any;
        return {
          success: true,
          statusCode: response.statusCode,
          message: 'Operation completed successfully',
          data,
          timestamp: new Date().toISOString(),
        };
      }),
    );
  }
}
