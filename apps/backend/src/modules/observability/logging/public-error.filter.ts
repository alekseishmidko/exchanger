import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * Глобальная public error boundary.
 * Ответ содержит стабильный code/message и correlationId; stack, internal
 * exception, Redis/PostgreSQL text и password policy details не сериализуются.
 */
@Catch()
export class PublicErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const response = http.getResponse<{
      status(code: number): { send(value: unknown): void };
      header?(name: string, value: string): void;
    }>();
    const supplied = request.headers?.['x-correlation-id'];
    const correlationId =
      (Array.isArray(supplied) ? supplied[0] : supplied)?.slice(0, 128) || randomUUID();
    const status =
      exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
    const body = exception instanceof HttpException ? exception.getResponse() : null;
    const safe = typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
    const code =
      typeof safe['code'] === 'string'
        ? safe['code']
        : status >= 500
          ? 'INTERNAL_ERROR'
          : 'REQUEST_REJECTED';
    const message =
      typeof safe['message'] === 'string'
        ? safe['message']
        : status >= 500
          ? 'Request could not be completed'
          : 'Request was rejected';
    response.header?.('x-correlation-id', correlationId);
    response.status(status).send({ code, message, correlationId });
  }
}
