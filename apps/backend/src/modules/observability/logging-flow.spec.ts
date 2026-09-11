import { ConfigService } from '@nestjs/config';
import { EventLog } from '../trading/event-log';
import { ProjectionEvent, ProjectionStore } from '../projections/projection';
import { LOG_EVENTS } from './log-events';
import { LoggingContext } from './logging-context';
import { StructuredLogRecord, StructuredLogger } from './structured-logger';

describe('Operational logging flow', () => {
  it('propagates correlation and causation through command, event and consumer', async () => {
    const records: StructuredLogRecord[] = [];
    const context = new LoggingContext();
    const logger = new StructuredLogger(
      context,
      new ConfigService({ NODE_ENV: 'test', SERVICE_NAME: 'flow-test' }),
      (record) => records.push(record),
    );
    const eventLog = new EventLog(logger, context);
    const projection = new ProjectionStore(logger);
    const event: ProjectionEvent = {
      eventId: 'event-1',
      eventType: 'OrderAccepted',
      sequence: 1,
      correlationId: 'correlation-1',
      causationId: 'command-1',
      payload: {
        orderId: 'order-1',
        userId: 'user-1',
        accountId: 'account-1',
        instrumentId: 'BTC-USD',
        remainingQuantity: '1',
      },
    };

    await context.run({ correlationId: 'correlation-1', commandId: 'command-1' }, async () => {
      logger.info('gateway', LOG_EVENTS.GATEWAY_COMMAND_ACCEPTED);
      await eventLog.append({
        eventId: event.eventId,
        eventType: event.eventType,
        correlationId: 'correlation-1',
        causationId: 'command-1',
        payload: event,
      });
    });
    await eventLog.consume(async (stored) => {
      projection.apply(stored.payload as ProjectionEvent);
      await Promise.resolve();
    });

    const commandRecord = records.find(
      ({ event: name }) => name === LOG_EVENTS.GATEWAY_COMMAND_ACCEPTED,
    );
    const appendRecord = records.find(({ event: name }) => name === LOG_EVENTS.EVENT_LOG_APPENDED);
    const projectionRecord = records.find(
      ({ event: name }) => name === LOG_EVENTS.PROJECTION_APPLIED,
    );
    expect(commandRecord).toMatchObject({ correlationId: 'correlation-1', commandId: 'command-1' });
    expect(appendRecord).toMatchObject({
      correlationId: 'correlation-1',
      causationId: 'command-1',
      eventId: 'event-1',
    });
    expect(projectionRecord).toMatchObject({
      correlationId: 'correlation-1',
      causationId: 'command-1',
      eventId: 'event-1',
    });
  });

  it('does not emit a second business-success event for duplicate delivery', () => {
    const records: StructuredLogRecord[] = [];
    const logger = new StructuredLogger(
      new LoggingContext(),
      new ConfigService({ NODE_ENV: 'test', SERVICE_NAME: 'duplicate-test' }),
      (record) => records.push(record),
    );
    const projection = new ProjectionStore(logger);
    const event: ProjectionEvent = {
      eventId: 'event-duplicate',
      eventType: 'OrderRejected',
      sequence: 1,
      payload: {
        orderId: 'order-1',
        userId: 'user-1',
        accountId: 'account-1',
        instrumentId: 'BTC-USD',
        remainingQuantity: '1',
      },
    };

    projection.apply(event);
    projection.apply(event);

    expect(
      records.filter(({ event: name }) => name === LOG_EVENTS.PROJECTION_APPLIED),
    ).toHaveLength(1);
    expect(
      records.filter(({ event: name }) => name === LOG_EVENTS.PROJECTION_DUPLICATE),
    ).toHaveLength(1);
  });
});
