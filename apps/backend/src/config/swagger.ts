import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

/** Результат подключения интерактивной документации к HTTP-приложению. */
export type SwaggerConfigurationResult = Readonly<{
  enabled: boolean;
  path: string;
}>;

/**
 * Подключает Swagger UI и машиночитаемые OpenAPI-документы.
 *
 * В development документация включена по умолчанию и доступна по `/docs`.
 * В production она выключена, пока оператор явно не задаст
 * `SWAGGER_ENABLED=true`. Такой режим не публикует описание защищённых endpoint
 * случайно, но позволяет включить его во внутреннем административном контуре.
 *
 * @example
 * ```ts
 * const config = app.get(ConfigService);
 * configureSwagger(app, config);
 * // UI: /docs, JSON: /docs/openapi.json, YAML: /docs/openapi.yaml
 * ```
 */
export function configureSwagger(
  app: INestApplication,
  config: ConfigService,
): SwaggerConfigurationResult {
  const environment = config.getOrThrow<string>('NODE_ENV');
  const explicitFlag = config.get<string>('SWAGGER_ENABLED', '');
  const enabled = explicitFlag === '' ? environment === 'development' : isEnabled(explicitFlag);
  const path = config.get<string>('SWAGGER_PATH', 'docs');

  if (!enabled) return { enabled, path };

  const documentConfig = new DocumentBuilder()
    .setTitle('Exchange Gateway API')
    .setDescription(
      'Command, query и технические HTTP-контракты биржи. Decimal-значения передаются строками.',
    )
    .setVersion('0.1.0')
    .addApiKey(
      {
        type: 'apiKey',
        in: 'header',
        name: 'x-api-key',
        description: 'API-ключ клиента. Не включайте ключ в URL или тело запроса.',
      },
      'ApiKeyAuth',
    )
    .build();

  SwaggerModule.setup(path, app, () => SwaggerModule.createDocument(app, documentConfig), {
    jsonDocumentUrl: `${path}/openapi.json`,
    yamlDocumentUrl: `${path}/openapi.yaml`,
    swaggerOptions: {
      persistAuthorization: false,
    },
  });

  return { enabled, path };
}

/** Преобразует уже проверенный environment-флаг в логическое значение. */
function isEnabled(value: string): boolean {
  return value === 'true' || value === '1';
}
