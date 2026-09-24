import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ZodValidationPipe } from '../../gateway/validation/gateway.validation';
import { IdentityService } from '../application/identity.service';
import { AdminSessionActionRequestDto, PublicSessionDto } from '../dto/identity.dto';
import { CsrfGuard } from '../security/csrf.guard';
import { HumanAuthenticatedRequest, HumanSessionGuard } from '../security/human-session.guard';
import { adminActionSchema } from '../validation/identity.validation';

/**
 * Административный session-control boundary.
 * Каждая mutation требует human ADMIN session, reason и Idempotency-Key; raw
 * credentials нельзя прочитать или установить через этот API. Повтор revoke
 * безопасен по семантике session store, а audit использует тот же command id.
 */
@Controller('api/v1/admin/users/:userId')
@UseGuards(HumanSessionGuard, CsrfGuard)
@ApiTags('Admin user sessions')
@ApiSecurity('SessionCookie')
export class AdminSessionsController {
  constructor(private readonly identity: IdentityService) {}

  /** Просматривает active/revoked metadata пользователя без token/digest. */
  @Get('sessions') @ApiOkResponse({ type: [PublicSessionDto] }) list(
    @Req() request: HumanAuthenticatedRequest,
    @Param('userId') userId: string,
  ): Promise<readonly PublicSessionDto[]> {
    return this.identity.adminListSessions(request.principal, userId);
  }

  /** Отзывает одну session и пишет неизменяемый audit record. */
  @Delete('sessions/:sessionId')
  @HttpCode(204)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiBody({ type: AdminSessionActionRequestDto })
  async revoke(
    @Req() request: HumanAuthenticatedRequest,
    @Param('userId') userId: string,
    @Param('sessionId') sessionId: string,
    @Headers('idempotency-key') commandId: string,
    @Body(new ZodValidationPipe(adminActionSchema)) body: z.infer<typeof adminActionSchema>,
  ): Promise<void> {
    this.requireCommandId(commandId);
    await this.identity.adminRevoke(request.principal, userId, sessionId, body.reason, commandId);
  }

  /** Отзывает все sessions пользователя; операция не возвращает credentials. */
  @Post('sessions/revoke-all')
  @ApiOperation({ summary: 'Принудительно завершить все сессии пользователя' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async revokeAll(
    @Req() request: HumanAuthenticatedRequest,
    @Param('userId') userId: string,
    @Headers('idempotency-key') commandId: string,
    @Body(new ZodValidationPipe(adminActionSchema)) body: z.infer<typeof adminActionSchema>,
  ): Promise<{ revokedCount: number }> {
    this.requireCommandId(commandId);
    return {
      revokedCount: await this.identity.adminRevokeAll(
        request.principal,
        userId,
        body.reason,
        commandId,
      ),
    };
  }

  /** Требует recovery и отзывает sessions, не принимая password в payload. */
  @Post('require-password-reset')
  @HttpCode(204)
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  async requireReset(
    @Req() request: HumanAuthenticatedRequest,
    @Param('userId') userId: string,
    @Headers('idempotency-key') commandId: string,
    @Body(new ZodValidationPipe(adminActionSchema)) body: z.infer<typeof adminActionSchema>,
  ): Promise<void> {
    this.requireCommandId(commandId);
    await this.identity.adminRequirePasswordReset(
      request.principal,
      userId,
      body.reason,
      commandId,
    );
  }

  private requireCommandId(value: string | undefined): asserts value is string {
    if (!value || !/^[A-Za-z0-9._:-]{8,128}$/.test(value))
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_REQUIRED',
        message: 'A valid Idempotency-Key is required',
      });
  }
}
