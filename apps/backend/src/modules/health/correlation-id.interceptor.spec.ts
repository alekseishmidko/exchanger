import { CallHandler, ExecutionContext } from '@nestjs/common';
import { of } from 'rxjs';
import { CorrelationIdInterceptor } from './correlation-id.interceptor';

describe('CorrelationIdInterceptor', () => {
  it('logs only technical fields and never request secrets', () => {
    const info = jest.fn();
    const response = { header: jest.fn(), statusCode: 200 };
    const request = {
      headers: { 'x-correlation-id': 'test-id', authorization: 'secret-token' },
      method: 'GET',
      url: '/health/live',
      log: { info },
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
        getResponse: () => response,
      }),
    } as unknown as ExecutionContext;
    const next: CallHandler = { handle: () => of({ status: 'ok' }) };

    new CorrelationIdInterceptor().intercept(context, next).subscribe();

    expect(info).toHaveBeenCalledWith(
      {
        correlationId: 'test-id',
        method: 'GET',
        url: '/health/live',
        statusCode: 200,
      },
      'HTTP request completed',
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain('secret-token');
  });
});
