import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBody, ApiOkResponse, ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ZodValidationPipe } from '../../gateway/validation/gateway.validation';
import { IdentityService, SessionContext } from '../application/identity.service';
import {
  AuthenticationResponseDto,
  ChangePasswordRequestDto,
  PublicSessionDto,
  PublicUserDto,
  UpdateProfileRequestDto,
} from '../dto/identity.dto';
import { CsrfGuard } from '../security/csrf.guard';
import { HumanAuthenticatedRequest, HumanSessionGuard } from '../security/human-session.guard';
import { changePasswordSchema, updateProfileSchema } from '../validation/identity.validation';

type Request = HumanAuthenticatedRequest & { ip?: string };
type Response = { header(name: string, value: string | readonly string[]): void };

/**
 * Self-service boundary: пользователь изменяет только name/password и управляет
 * только собственными sessions. Поля role, ownerId, verification/security flags
 * отсутствуют в DTO и дополнительно отсекаются strict runtime schemas.
 */
@Controller('api/v1/users/me')
@UseGuards(HumanSessionGuard, CsrfGuard)
@ApiTags('User self-service')
@ApiSecurity('SessionCookie')
export class UsersSelfServiceController {
  constructor(
    private readonly identity: IdentityService,
    private readonly config: ConfigService,
    private readonly csrf: CsrfGuard,
  ) {}

  /** Изменяет display name с аудитом и безопасным response. */
  @Patch()
  @ApiOperation({ summary: 'Изменить своё имя' })
  @ApiBody({ type: UpdateProfileRequestDto })
  @ApiOkResponse({ type: PublicUserDto })
  update(
    @Req() request: Request,
    @Body(new ZodValidationPipe(updateProfileSchema)) body: z.infer<typeof updateProfileSchema>,
  ): Promise<PublicUserDto> {
    return this.identity.updateProfile(request.principal, body.name, this.correlation(request));
  }

  /** Меняет password после re-auth, инвалидирует stale securityVersion и ротирует session. */
  @Post('password')
  @ApiBody({ type: ChangePasswordRequestDto })
  @ApiOkResponse({ type: AuthenticationResponseDto })
  async password(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
    @Body(new ZodValidationPipe(changePasswordSchema)) body: z.infer<typeof changePasswordSchema>,
  ): Promise<AuthenticationResponseDto> {
    const result = await this.identity.changePassword(
      request.principal,
      body,
      this.context(request),
    );
    const secure = this.config.get('AUTH_COOKIE_SECURE', 'false') === 'true';
    const maxAge = this.config.get<string>('AUTH_SESSION_IDLE_TTL_SECONDS', '1800');
    response.header('Set-Cookie', [
      `${this.config.get('AUTH_COOKIE_NAME', 'exchange_session')}=${result.token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`,
      `${this.config.get('AUTH_CSRF_COOKIE_NAME', 'exchange_csrf')}=${this.csrf.token(result.session.sessionId)}; Path=/; Max-Age=${maxAge}; SameSite=Strict${secure ? '; Secure' : ''}`,
    ]);
    return { user: result.user, session: result.session };
  }

  /** Перечисляет active/revoked metadata собственных sessions без credentials. */
  @Get('sessions') @ApiOkResponse({ type: [PublicSessionDto] }) sessions(
    @Req() request: Request,
  ): Promise<readonly PublicSessionDto[]> {
    return this.identity.listSessions(request.principal);
  }

  /** Точечно отзывает собственную session по безопасному public sessionId. */
  @Delete('sessions/:sessionId') @HttpCode(204) async revoke(
    @Req() request: Request,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    await this.identity.revokeOwnSession(request.principal, sessionId, this.correlation(request));
  }

  private correlation(request: Request): string {
    const value = request.headers['x-correlation-id'];
    return (Array.isArray(value) ? value[0] : value)?.slice(0, 128) || randomUUID();
  }
  private context(request: Request): SessionContext {
    const ua = request.headers['user-agent'];
    return {
      correlationId: this.correlation(request),
      deviceLabel: 'password change',
      userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? '',
      ip: request.ip ?? '',
    };
  }
}
