/**
 * Файл содержит REST boundary API-key authentication lifecycle.
 *
 * Endpoints помогают Swagger/manual clients проверить текущий principal и
 * администрировать API keys. Это не password/session auth: controller работает
 * с `ApiKeyRegistry`, idempotency и audit port, не создавая пользовательских
 * Redis sessions.
 */
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  Headers,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiSecurity,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { AUDIT_LOG_PORT, AuditLogPort } from '../../audit';
import {
  ApiKeyMetadataPageResponseDto,
  ApiKeyMetadataResponseDto,
  AuthenticationPrincipalResponseDto,
  IssuedApiKeyResponseDto,
  IssueApiKeyRequestDto,
  MutateApiKeyRequestDto,
} from '../dto/auth.dto';
import {
  ApiKeyGuard,
  ApiKeyPrincipal,
  ApiKeyRegistry,
  assertAdminAccess,
  assertApiKeyScope,
} from '../auth/gateway.auth';
import { RateLimitService } from '../application/gateway.rate-limit';
import { IDEMPOTENCY_STORE_PORT, IdempotencyStorePort } from '../ports/gateway.idempotency.port';
import { issueApiKeySchema, mutateApiKeySchema } from '../validation/auth.validation';
import { ZodValidationPipe } from '../validation/gateway.validation';
import { LOG_EVENTS, StructuredLogger } from '../../observability';

/** HTTP request после успешной установки principal в `ApiKeyGuard`. */
type AuthenticationRequest = Readonly<{ principal: ApiKeyPrincipal }>;

/**
 * Публикует явную transport boundary проверки API key для Swagger-клиента.
 *
 * Аутентификация остаётся stateless: клиент нажимает `Authorize`, передаёт ключ
 * в `x-api-key`, guard проверяет его до вызова handler, а `/auth/me` показывает
 * безопасное представление identity. Endpoint не является login/password flow,
 * не создаёт сессию и никогда не возвращает credential обратно.
 *
 * @example
 * `GET /api/v1/auth/me` с `x-api-key: <secret>` возвращает subject и role; тот
 * же запрос без ключа получает безопасный `401 AUTH_INVALID_API_KEY`.
 */
@Controller('api/v1/machine-auth')
@UseGuards(ApiKeyGuard)
@ApiTags('Authentication')
@ApiSecurity('ApiKeyAuth')
@ApiUnauthorizedResponse({ description: 'API-ключ отсутствует или недействителен.' })
export class AuthenticationController {
  /**
   * Собирает authentication transport boundary из application ports.
   *
   * Registry отвечает только за API-key lifecycle, idempotency port подавляет
   * повтор write-команд, rate limiter ограничивает principal, а audit port
   * сохраняет административный след без прямого доступа controller к storage.
   *
   * @param registry Реестр безопасной metadata API keys.
   * @param idempotency Порт дедупликации write-запросов.
   * @param rateLimit Общий rate limiter authentication endpoints.
   * @param audit Append-only порт административного аудита.
   */
  constructor(
    private readonly registry: ApiKeyRegistry,
    @Inject(IDEMPOTENCY_STORE_PORT) private readonly idempotency: IdempotencyStorePort,
    private readonly rateLimit: RateLimitService,
    @Inject(AUDIT_LOG_PORT) private readonly audit: AuditLogPort,
    private readonly logger: StructuredLogger,
  ) {}

  /**
   * Подтверждает, что Swagger/API-клиент успешно прошёл API-key authentication.
   *
   * Handler получает только principal, уже созданный guard-ом, применяет общий
   * rate limit и маппит identity в allow-listed DTO. Например, внутренний
   * `principal.keyId` не копируется в ответ даже при успешной проверке.
   */
  @Get('me')
  @ApiOperation({
    summary: 'Проверить API key и получить текущую identity',
    description:
      'Сначала укажите x-api-key через кнопку Authorize. Endpoint не создаёт сессию и не возвращает секрет.',
  })
  @ApiOkResponse({ type: AuthenticationPrincipalResponseDto })
  @ApiTooManyRequestsResponse({ description: 'Превышен лимит запросов API-ключа.' })
  getCurrentPrincipal(@Req() request: AuthenticationRequest): AuthenticationPrincipalResponseDto {
    this.rateLimit.check(request.principal.keyId);
    return {
      authenticated: true,
      authenticationScheme: 'API_KEY',
      subjectId: request.principal.userId,
      role: request.principal.role,
    };
  }

  /**
   * Выпускает новый credential после admin authorization и сохраняет audit event.
   * Secret появляется только в этом response; идемпотентный retry той же команды
   * возвращает исходный результат вместо создания второго ключа.
   */
  @Post('api-keys')
  @ApiOperation({ summary: 'Выпустить новый API key' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ type: IssueApiKeyRequestDto })
  @ApiCreatedResponse({ type: IssuedApiKeyResponseDto })
  @ApiForbiddenResponse({ description: 'Требуется роль admin.' })
  @ApiBadRequestResponse({ description: 'DTO или Idempotency-Key некорректны.' })
  @ApiConflictResponse({ description: 'Idempotency-Key связан с другим запросом.' })
  issueApiKey(
    @Req() request: AuthenticationRequest,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(issueApiKeySchema)) body: z.infer<typeof issueApiKeySchema>,
  ): Promise<IssuedApiKeyResponseDto> {
    this.admitAdmin(request.principal);
    const key = this.requireIdempotencyKey(idempotencyKey);
    return this.idempotency
      .executeSensitive(`${request.principal.keyId}:${key}`, body, async () => {
        const issued = await this.registry.issue(body);
        await this.audit.append(
          { actorId: request.principal.userId, role: 'ADMIN' },
          'ACTION_APPLIED',
          'ISSUE_API_KEY',
          body.commandId,
          issued.metadata.keyId,
          { subjectId: body.userId, role: body.role, label: body.label },
        );
        return Promise.resolve({ apiKey: issued.apiKey, metadata: issued.metadata });
      })
      .then((result) => {
        if (result.replayed)
          throw new ConflictException({
            code: 'CREDENTIAL_SECRET_ALREADY_SHOWN',
            message: 'Credential was already issued; rotate it to obtain a new secret',
          });
        return result.value;
      });
  }

  /** Возвращает admin-only список active/revoked metadata без secret/digest. */
  @Get('api-keys')
  @ApiOperation({ summary: 'Получить безопасный список API keys' })
  @ApiOkResponse({ type: ApiKeyMetadataPageResponseDto })
  @ApiForbiddenResponse({ description: 'Требуется роль admin.' })
  async listApiKeys(@Req() request: AuthenticationRequest): Promise<ApiKeyMetadataPageResponseDto> {
    this.admitAdmin(request.principal);
    return { items: [...(await this.registry.list())] };
  }

  /**
   * Немедленно инвалидирует старый secret и возвращает новый ровно один раз.
   * Stable keyId позволяет сохранить audit/revocation identity при rotation.
   */
  @Post('api-keys/:keyId/rotate')
  @ApiOperation({ summary: 'Ротировать существующий API key' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiParam({ name: 'keyId', example: 'key-550e8400-e29b-41d4-a716-446655440000' })
  @ApiBody({ type: MutateApiKeyRequestDto })
  @ApiCreatedResponse({ type: IssuedApiKeyResponseDto })
  @ApiNotFoundResponse({ description: 'API key не найден.' })
  @ApiConflictResponse({ description: 'Ключ отозван или idempotency conflict.' })
  rotateApiKey(
    @Req() request: AuthenticationRequest,
    @Param('keyId') keyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(mutateApiKeySchema)) body: z.infer<typeof mutateApiKeySchema>,
  ): Promise<IssuedApiKeyResponseDto> {
    this.admitAdmin(request.principal);
    this.rejectSelfMutation(request.principal, keyId);
    const key = this.requireIdempotencyKey(idempotencyKey);
    return this.idempotency
      .executeSensitive(`${request.principal.keyId}:${key}`, { keyId, ...body }, async () => {
        const issued = await this.registry.rotate(keyId);
        await this.audit.append(
          { actorId: request.principal.userId, role: 'ADMIN' },
          'ACTION_APPLIED',
          'ROTATE_API_KEY',
          body.commandId,
          keyId,
        );
        return Promise.resolve({ apiKey: issued.apiKey, metadata: issued.metadata });
      })
      .then((result) => {
        if (result.replayed)
          throw new ConflictException({
            code: 'CREDENTIAL_SECRET_ALREADY_SHOWN',
            message: 'Credential was already issued; rotate it to obtain a new secret',
          });
        return result.value;
      });
  }

  /** Отзывает credential, сохраняя metadata и audit chain для расследования. */
  @Post('api-keys/:keyId/revoke')
  @ApiOperation({ summary: 'Отозвать API key' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiParam({ name: 'keyId', example: 'key-550e8400-e29b-41d4-a716-446655440000' })
  @ApiBody({ type: MutateApiKeyRequestDto })
  @ApiCreatedResponse({ type: ApiKeyMetadataResponseDto })
  @ApiNotFoundResponse({ description: 'API key не найден.' })
  revokeApiKey(
    @Req() request: AuthenticationRequest,
    @Param('keyId') keyId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body(new ZodValidationPipe(mutateApiKeySchema)) body: z.infer<typeof mutateApiKeySchema>,
  ): Promise<ApiKeyMetadataResponseDto> {
    this.admitAdmin(request.principal);
    this.rejectSelfMutation(request.principal, keyId);
    const key = this.requireIdempotencyKey(idempotencyKey);
    return this.idempotency.execute(
      `${request.principal.keyId}:${key}`,
      { keyId, ...body },
      async () => {
        const metadata = await this.registry.revoke(keyId);
        await this.audit.append(
          { actorId: request.principal.userId, role: 'ADMIN' },
          'ACTION_APPLIED',
          'REVOKE_API_KEY',
          body.commandId,
          keyId,
        );
        this.logger.info('gateway', LOG_EVENTS.AUTH_CREDENTIAL_REVOKED, {
          outcome: 'success',
          correlationId: body.commandId,
          metadata: { credentialType: 'api-key' },
        });
        return Promise.resolve(metadata);
      },
    );
  }

  /** Выполняет общие role/rate checks до любого auth administration handler. */
  private admitAdmin(principal: ApiKeyPrincipal): void {
    assertAdminAccess(principal);
    assertApiKeyScope(principal, 'admin:*');
    this.rateLimit.check(principal.keyId);
  }

  /**
   * Не позволяет текущему credential инвалидировать самого себя: при сетевом
   * timeout оператор мог бы потерять новый secret и доступ к recovery API.
   * Rotation/revoke выполняются другим admin credential.
   */
  private rejectSelfMutation(principal: ApiKeyPrincipal, targetKeyId: string): void {
    if (principal.keyId === targetKeyId) {
      throw new ForbiddenException({
        code: 'API_KEY_SELF_MUTATION_FORBIDDEN',
        message: 'Use another administrator credential for this operation',
      });
    }
  }

  /** Отклоняет отсутствующий или небезопасный idempotency header до mutation. */
  private requireIdempotencyKey(value: string | undefined): string {
    if (!value || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'Idempotency-Key header is required',
      });
    }
    return value;
  }
}
