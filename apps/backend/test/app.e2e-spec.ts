import { Test } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import { AppModule } from '../src/app.module';
import { configureSwagger } from '../src/config/swagger';

/** Минимальная часть OpenAPI-документа, которую проверяет smoke-тест. */
type OpenApiSmokeDocument = {
  info: { title: string };
  paths: Record<string, { post?: unknown }>;
  components: {
    securitySchemes: Record<string, { type: string; in: string; name: string }>;
  };
};

describe('Application smoke test', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    configureSwagger(
      app,
      new ConfigService({ NODE_ENV: 'development', SWAGGER_ENABLED: 'true', SWAGGER_PATH: 'docs' }),
    );
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

  it('publishes Swagger UI and the generated Gateway OpenAPI contract', async () => {
    const server = app.getHttpServer() as unknown as Parameters<typeof request>[0];

    await request(server)
      .get('/docs')
      .expect(200)
      .expect('content-type', /text\/html/);

    const response = await request(server).get('/docs/openapi.json').expect(200);
    const document = response.body as OpenApiSmokeDocument;
    expect(document.info.title).toBe('Exchange Gateway API');
    expect(document.paths['/api/v1/orders']?.post).toBeDefined();
    expect(document.components.securitySchemes['ApiKeyAuth']).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'x-api-key',
    });
  });
});
