import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

type RequestLike = {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly method?: string;
  readonly url?: string;
  readonly log?: {
    info(fields: Record<string, string | number>, message: string): void;
  };
};

type ResponseLike = {
  header?(name: string, value: string): void;
  setHeader?(name: string, value: string): void;
  statusCode?: number;
};

/** Переносит correlation ID через HTTP и пишет безопасный structured log. */
@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  /** Прикрепляет ID к ответу и логирует только технические поля запроса. */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestLike>();
    const response = context.switchToHttp().getResponse<ResponseLike>();
    const header = request.headers['x-correlation-id'];
    const suppliedId = Array.isArray(header) ? header[0] : header;
    const correlationId = suppliedId?.trim().slice(0, 128) || randomUUID();

    if (response.header) {
      response.header('x-correlation-id', correlationId);
    } else {
      response.setHeader?.('x-correlation-id', correlationId);
    }

    return next.handle().pipe(
      tap(() => {
        request.log?.info(
          {
            correlationId,
            method: request.method ?? 'unknown',
            url: request.url ?? 'unknown',
            statusCode: response.statusCode ?? 200,
          },
          'HTTP request completed',
        );
      }),
    );
  }
}
