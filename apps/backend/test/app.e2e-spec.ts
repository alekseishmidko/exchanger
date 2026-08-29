import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Application smoke test', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    const fastify = app.getHttpAdapter().getInstance() as unknown as {
      ready: () => Promise<void>;
    };
    await fastify.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('exposes health endpoint', async () => {
    const server = app.getHttpServer() as unknown as Parameters<typeof request>[0];
    await request(server)
      .get('/health/live')
      .set('x-correlation-id', 'smoke-test')
      .expect(200)
      .expect('x-correlation-id', 'smoke-test')
      .expect({ status: 'ok' });
  });

  it('reports readiness independently from liveness', async () => {
    const server = app.getHttpServer() as unknown as Parameters<typeof request>[0];
    await request(server).get('/health/ready').expect(200).expect({ status: 'ok', checks: {} });
  });
});
