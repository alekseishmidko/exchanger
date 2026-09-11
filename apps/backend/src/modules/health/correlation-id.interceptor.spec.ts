import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { CorrelationIdInterceptor } from './correlation-id.interceptor';
import { LoggingContext, StructuredLogRecord, StructuredLogger } from '../observability';

describe('CorrelationIdInterceptor', () => {
  it('logs only technical fields and never request secrets', () => {
    const records: StructuredLogRecord[] = [];
    const response = { header: jest.fn(), statusCode: 200 };
    const request = {
      headers: { 'x-correlation-id': 'test-id', authorization: 'secret-token' },
      method: 'GET',
      url: '/health/live',
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of({ status: 'ok' }) };

    const loggingContext = new LoggingContext();
    const logger = new StructuredLogger(loggingContext, undefined, (record) =>
      records.push(record),
    );
    new CorrelationIdInterceptor(loggingContext, logger).intercept(context, next).subscribe();

    expect(records).toEqual([
      expect.objectContaining({
        correlationId: 'test-id',
        event: 'http.request.completed',
        metadata: { method: 'GET', route: '/health/live', statusCode: 200 },
      }),
    ]);
    expect(JSON.stringify(records)).not.toContain('secret-token');
  });
});
