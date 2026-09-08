import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
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
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import {
  ApiKeyGuard,
  ApiKeyPrincipal,
  assertAdminAccess,
  assertObjectAccess,
} from '../gateway/gateway.auth';
import { IdempotencyStore } from '../gateway/gateway.idempotency';
import { RateLimitService } from '../gateway/gateway.rate-limit';
import { ZodValidationPipe } from '../gateway/gateway.validation';
import {
  AccountBalancesResponseDto,
  AccountResponseDto,
  BalanceResponseDto,
  ChangeBalanceRequestDto,
  CreateAccountRequestDto,
} from './ledger.dto';
import { LedgerApplicationService } from './ledger-application.service';
import { changeBalanceSchema, createAccountSchema } from './ledger.validation';

/** HTTP request с principal, установленным ApiKeyGuard. */
type LedgerRequest = { principal: ApiKeyPrincipal };

/**
 * REST adapter account/balance application boundary.
 *
 * Read handlers сначала получают owner из application service и затем проверяют
 * object access. Write handlers дополнительно требуют Idempotency-Key; изменение
 * денег требует admin role и всегда проходит через `changeBalance`.
 */
@Controller('api/v1/accounts')
@UseGuards(ApiKeyGuard)
@ApiTags('Accounts and balances')
@ApiSecurity('ApiKeyAuth')
@ApiUnauthorizedResponse({ description: 'API-ключ отсутствует или недействителен.' })
@ApiForbiddenResponse({ description: 'Нет доступа к аккаунту или admin-команде.' })
export class LedgerController {
  constructor(
    private readonly application: LedgerApplicationService,
    private readonly idempotency: IdempotencyStore,
    private readonly rateLimit: RateLimitService,
  ) {}

  /** Создаёт принадлежащий principal аккаунт с нулевыми балансами. */
  @Post()
  @ApiOperation({ summary: 'Создать ledger-аккаунт' })
  @ApiBody({ type: CreateAccountRequestDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: AccountResponseDto })
  @ApiBadRequestResponse({ description: 'Некорректный DTO или Idempotency-Key.' })
  @ApiConflictResponse({ description: 'Аккаунт существует или ключ повторён с другим payload.' })
  createAccount(
    @Req() request: LedgerRequest,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(createAccountSchema)) body: z.infer<typeof createAccountSchema>,
  ): Promise<AccountResponseDto> {
    assertObjectAccess(request.principal, body.ownerId);
    return this.execute(request.principal, key, body, () =>
      this.application.createAccount(
        body.commandId,
        body.accountId,
        body.ownerId,
        body.balances,
        request.principal.userId,
      ),
    );
  }

  /** Возвращает metadata аккаунта только его владельцу или admin. */
  @Get(':accountId')
  @ApiOperation({ summary: 'Получить ledger-аккаунт' })
  @ApiParam({ name: 'accountId', example: 'account-1' })
  @ApiOkResponse({ type: AccountResponseDto })
  @ApiNotFoundResponse({ description: 'Аккаунт не найден.' })
  getAccount(
    @Req() request: LedgerRequest,
    @Param('accountId') accountId: string,
  ): AccountResponseDto {
    const account = this.application.getAccount(accountId);
    assertObjectAccess(request.principal, account.ownerId);
    return account;
  }

  /** Возвращает available/reserved snapshots всех assets аккаунта. */
  @Get(':accountId/balances')
  @ApiOperation({ summary: 'Получить балансы аккаунта' })
  @ApiOkResponse({ type: AccountBalancesResponseDto })
  getBalances(
    @Req() request: LedgerRequest,
    @Param('accountId') accountId: string,
  ): AccountBalancesResponseDto {
    this.authorizeAccount(request.principal, accountId);
    return { items: [...this.application.getBalances(accountId)] };
  }

  /** Возвращает один balance snapshot в точных decimal strings. */
  @Get(':accountId/balances/:assetId')
  @ApiOperation({ summary: 'Получить баланс аккаунта по активу' })
  @ApiOkResponse({ type: BalanceResponseDto })
  @ApiNotFoundResponse({ description: 'Аккаунт или баланс не найден.' })
  getBalance(
    @Req() request: LedgerRequest,
    @Param('accountId') accountId: string,
    @Param('assetId') assetId: string,
  ): BalanceResponseDto {
    this.authorizeAccount(request.principal, accountId);
    return this.application.getBalance(accountId, assetId);
  }

  /** Выполняет admin-only credit/debit/reserve/release application command. */
  @Post(':accountId/balances/:assetId/commands')
  @ApiOperation({ summary: 'Применить административную balance-команду' })
  @ApiBody({ type: ChangeBalanceRequestDto })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiCreatedResponse({ type: BalanceResponseDto })
  @ApiBadRequestResponse({ description: 'DTO, сумма или Idempotency-Key некорректны.' })
  changeBalance(
    @Req() request: LedgerRequest,
    @Param('accountId') accountId: string,
    @Param('assetId') assetId: string,
    @Headers('idempotency-key') key: string | undefined,
    @Body(new ZodValidationPipe(changeBalanceSchema)) body: z.infer<typeof changeBalanceSchema>,
  ): Promise<BalanceResponseDto> {
    assertAdminAccess(request.principal);
    return this.execute(request.principal, key, { accountId, assetId, ...body }, () =>
      this.application.changeBalance(body.commandId, accountId, assetId, body.action, body.amount, {
        actorId: request.principal.userId,
        role: 'ADMIN',
      }),
    );
  }

  /** Проверяет owner account перед любым чтением финансового snapshot. */
  private authorizeAccount(principal: ApiKeyPrincipal, accountId: string): void {
    assertObjectAccess(principal, this.application.getAccount(accountId).ownerId);
  }

  /** Выполняет rate limit и общую idempotency boundary write-запросов. */
  private execute<T>(
    principal: ApiKeyPrincipal,
    key: string | undefined,
    payload: unknown,
    operation: () => T,
  ): Promise<T> {
    this.rateLimit.check(principal.keyId);
    const idempotencyKey = this.requireIdempotencyKey(key);
    return this.idempotency.execute(
      `${principal.keyId}:${idempotencyKey}`,
      { actorId: principal.userId, payload },
      () => Promise.resolve(operation()),
    );
  }

  /** Отклоняет отсутствующий или небезопасный Idempotency-Key до domain call. */
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
