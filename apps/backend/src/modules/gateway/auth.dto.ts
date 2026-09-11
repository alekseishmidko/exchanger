import { ApiProperty } from '@nestjs/swagger';
import { ApiKeyRole } from './gateway.auth';

/**
 * Публичный результат проверки API key текущего запроса.
 *
 * DTO намеренно не содержит исходный ключ и внутренний `keyId`: credential может
 * использоваться для rate limiting и revocation внутри security boundary, но не
 * должен отражаться обратно клиенту. `subjectId` и `role` позволяют Swagger-
 * пользователю проверить, от имени кого будут выполняться следующие команды.
 *
 * @example
 * ```json
 * {
 *   "authenticated": true,
 *   "authenticationScheme": "API_KEY",
 *   "subjectId": "user-1",
 *   "role": "trader"
 * }
 * ```
 */
export class AuthenticationPrincipalResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  authenticated!: true;

  @ApiProperty({ enum: ['API_KEY'], example: 'API_KEY' })
  authenticationScheme!: 'API_KEY';

  @ApiProperty({ example: 'user-1', description: 'Идентификатор владельца API key.' })
  subjectId!: string;

  @ApiProperty({
    enum: ['trader', 'admin', 'risk_manager', 'auditor', 'support'],
    example: 'trader',
  })
  role!: ApiKeyRole;
}

/**
 * Admin-only команда выпуска нового credential для указанной identity.
 * `commandId` нужен для audit/idempotency, а label является безопасным
 * операторским назначением, например `market-maker-primary`.
 */
export class IssueApiKeyRequestDto {
  @ApiProperty({ example: 'issue-key-command-1' })
  commandId!: string;

  @ApiProperty({ example: 'user-1' })
  userId!: string;

  @ApiProperty({ enum: ['trader', 'admin', 'risk_manager', 'auditor', 'support'] })
  role!: ApiKeyRole;

  @ApiProperty({ example: 'market-maker-primary', maxLength: 128 })
  label!: string;
}

/** Команда rotate/revoke, обеспечивающая audit correlation и idempotency. */
export class MutateApiKeyRequestDto {
  @ApiProperty({ example: 'rotate-key-command-1' })
  commandId!: string;
}

/**
 * Безопасные metadata credential. Секрет и его digest отсутствуют во всех
 * list/revoke responses; status сохраняется после отзыва для расследования.
 */
export class ApiKeyMetadataResponseDto {
  @ApiProperty({ example: 'key-550e8400-e29b-41d4-a716-446655440000' }) keyId!: string;
  @ApiProperty({ example: 'user-1' }) userId!: string;
  @ApiProperty({ enum: ['trader', 'admin', 'risk_manager', 'auditor', 'support'] })
  role!: ApiKeyRole;
  @ApiProperty({ example: 'market-maker-primary' }) label!: string;
  @ApiProperty({ enum: ['ACTIVE', 'REVOKED'] }) status!: 'ACTIVE' | 'REVOKED';
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true }) rotatedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) revokedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true }) lastUsedAt!: string | null;
}

/** Страница полного reference registry без credential material. */
export class ApiKeyMetadataPageResponseDto {
  @ApiProperty({ type: [ApiKeyMetadataResponseDto] })
  items!: ApiKeyMetadataResponseDto[];
}

/**
 * Одноразовый ответ issue/rotate. `apiKey` следует передать владельцу через
 * secret channel: получить его повторно через list API невозможно.
 *
 * @example
 * `{ "apiKey": "ex_...", "metadata": { "keyId": "key-...", "status": "ACTIVE" } }`
 */
export class IssuedApiKeyResponseDto {
  @ApiProperty({
    example: 'ex_example-secret-returned-once',
    description: 'Secret возвращается только в результате issue/rotate и отсутствует в list API.',
  })
  apiKey!: string;

  @ApiProperty({ type: ApiKeyMetadataResponseDto })
  metadata!: ApiKeyMetadataResponseDto;
}
