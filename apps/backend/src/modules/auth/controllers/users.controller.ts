/**
 * HTTP boundary self-service для уже аутентифицированного пользователя.
 * Все endpoints проходят session и CSRF guards до изменения profile/password/session state.
 */
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
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ZodValidationPipe } from '../../gateway/validation/gateway.validation';
import { HumanAuthService, SessionContext } from '../application/human-auth.service';
import {
  AuthenticationResponseDto,
  ChangePasswordRequestDto,
  PublicSessionDto,
  PublicUserDto,
  UpdateProfileRequestDto,
} from '../dto/human-auth.dto';
import { CsrfGuard } from '../security/csrf.guard';
import { HumanAuthenticatedRequest, HumanSessionGuard } from '../security/human-session.guard';
import { CookieResponse, SessionCookieService } from '../security/session-cookie.service';
import { changePasswordSchema, updateProfileSchema } from '../validation/human-auth.validation';

type Request = HumanAuthenticatedRequest & { ip?: string };
type Response = CookieResponse;

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
  /**
   * @param identity Application use cases текущего пользователя.
   * @param cookies Adapter безопасной ротации session/CSRF cookies после смены password.
   */
  constructor(
    private readonly identity: HumanAuthService,
    private readonly cookies: SessionCookieService,
  ) {}

  /** Изменяет только display name после strict DTO validation и возвращает public profile. */
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

  /**
   * Меняет password после re-auth, инвалидирует stale securityVersion и ротирует session.
   * Новый raw token сразу преобразуется в HttpOnly cookie и не возвращается клиентскому JS.
   */
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
    this.cookies.set(response, result);
    return { user: result.user, session: result.session };
  }

  /** Перечисляет active/revoked metadata только собственных sessions без credentials. */
  @Get('sessions') @ApiOkResponse({ type: [PublicSessionDto] }) sessions(
    @Req() request: Request,
  ): Promise<readonly PublicSessionDto[]> {
    return this.identity.listSessions(request.principal);
  }

  /** Точечно отзывает собственную session по public sessionId с audit correlation. */
  @Delete('sessions/:sessionId') @HttpCode(204) async revoke(
    @Req() request: Request,
    @Param('sessionId') sessionId: string,
  ): Promise<void> {
    await this.identity.revokeOwnSession(request.principal, sessionId, this.correlation(request));
  }

  /** Нормализует входной correlation id до bounded audit identifier. */
  private correlation(request: Request): string {
    const value = request.headers['x-correlation-id'];
    return (Array.isArray(value) ? value[0] : value)?.slice(0, 128) || randomUUID();
  }
  /** Собирает контекст ротации session; IP и user-agent далее сохраняются только как HMAC. */
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
