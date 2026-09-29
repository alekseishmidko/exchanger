import {
  buildTwelveDataDiagnosticParams,
  parseTwelveDataDiagnosticRequest,
} from './twelve-data-diagnostics.service';

describe('Twelve Data diagnostics', () => {
  it('accepts only the fixed REST allowlist and bounded parameters', () => {
    const request = parseTwelveDataDiagnosticRequest({
      transport: 'REST',
      endpoint: '/time_series',
      symbol: 'BTC/USD',
      exchange: 'Binance',
      interval: '1min',
      outputsize: 25,
    });

    expect(buildTwelveDataDiagnosticParams({ ...request, endpoint: '/time_series' })).toEqual({
      format: 'JSON',
      symbol: 'BTC/USD',
      exchange: 'Binance',
      interval: '1min',
      outputsize: 25,
    });
    expect(() =>
      parseTwelveDataDiagnosticRequest({
        transport: 'REST',
        endpoint: 'https://attacker.test/collect',
        symbol: 'BTC/USD',
      }),
    ).toThrow('TWELVE_DATA_DIAGNOSTIC_REQUEST_INVALID');
    expect(() =>
      parseTwelveDataDiagnosticRequest({
        transport: 'REST',
        endpoint: '/quote',
        symbol: 'BTC/USD',
        outputsize: 10_000,
      }),
    ).toThrow('TWELVE_DATA_DIAGNOSTIC_REQUEST_INVALID');
  });

  it('requires symbols and a time-series interval without accepting unknown fields', () => {
    expect(() => parseTwelveDataDiagnosticRequest({ transport: 'WEBSOCKET' })).toThrow(
      'TWELVE_DATA_DIAGNOSTIC_SYMBOL_REQUIRED',
    );
    expect(() =>
      parseTwelveDataDiagnosticRequest({
        transport: 'REST',
        endpoint: '/time_series',
        symbol: 'BTC/USD',
      }),
    ).toThrow('TWELVE_DATA_DIAGNOSTIC_INTERVAL_REQUIRED');
    expect(() =>
      parseTwelveDataDiagnosticRequest({
        transport: 'REST',
        endpoint: '/quote',
        symbol: 'BTC/USD',
        url: 'https://attacker.test',
      }),
    ).toThrow('TWELVE_DATA_DIAGNOSTIC_REQUEST_INVALID');
  });
});
