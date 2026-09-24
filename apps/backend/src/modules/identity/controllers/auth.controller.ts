import { Body, Controller, Get, HttpCode, Post, Req, Res, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiSecurity,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ZodValidationPipe } from '../../gateway/validation/gateway.validation';
import {
  IdentityService,
  SessionContext,
  SessionIssueResult,
} from '../application/identity.service';
import {
  AuthenticationResponseDto,
  CurrentUserResponseDto,
  LoginRequestDto,
  RegisterRequestDto,
} from '../dto/identity.dto';
import { CsrfGuard } from '../security/csrf.guard';
import { HumanAuthenticatedRequest, HumanSessionGuard } from '../security/human-session.guard';
import { AuthRateLimit } from '../security/auth-rate-limit';
import {
  challengeSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '../validation/identity.validation';

type HttpRequest = HumanAuthenticatedRequest & {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
};
type HttpResponse = { header(name: string, value: string | readonly string[]): void };

/**
 * Password/session authentication boundary для человека.
 *
 * Register/login устанавливают opaque HttpOnly cookie, но response содержит
 * только profile и session metadata. Recovery request всегда отвечает одинаково,
 * поэтому API не является email enumeration oracle.
 */
@Controller('api/v1/auth')
@ApiTags('User authentication')
export class UserAuthenticationController {
  constructor(
    private readonly identity: IdentityService,
    private readonly config: ConfigService,
    private readonly limiter: AuthRateLimit,
    private readonly csrf: CsrfGuard,
  ) {}

  /** Создаёт user с normalized email и новую server session. */
  @Post('register')
  @ApiOperation({ summary: 'Зарегистрировать пользователя' })
  @ApiBody({ type: RegisterRequestDto })
  @ApiCreatedResponse({ type: AuthenticationResponseDto })
  async register(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
    @Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>,
  ): Promise<AuthenticationResponseDto> {
    this.rateLimit(request, body.email);
    return this.respondWithSession(
      response,
      await this.identity.register(body, this.context(request, 'new device')),
    );
  }

  /** Аутентифицирует password без раскрытия причины отказа и предотвращает fixation. */
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Войти и создать server session' })
  @ApiBody({ type: LoginRequestDto })
  @ApiOkResponse({ type: AuthenticationResponseDto })
  @ApiUnauthorizedResponse({
    description: 'Единая ошибка для неизвестного email и неверного password.',
  })
  async login(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
  ): Promise<AuthenticationResponseDto> {
    this.rateLimit(request, body.email);
    return this.respondWithSession(
      response,
      await this.identity.login(body, this.context(request, body.deviceLabel ?? 'unknown device')),
    );
  }

  /** Возвращает allow-listed profile и capabilities после live session lookup. */
  @Get('me')
  @UseGuards(HumanSessionGuard)
  @ApiSecurity('SessionCookie')
  @ApiOkResponse({ type: CurrentUserResponseDto })
  me(@Req() request: HttpRequest): Promise<CurrentUserResponseDto> {
    return this.identity
      .me(request.principal)
      .then((value) => ({ user: value.user, capabilities: [...value.capabilities] }));
  }

  /** Завершает текущую сессию и очищает cookies. */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(HumanSessionGuard, CsrfGuard)
  @ApiSecurity('SessionCookie')
  async logout(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.identity.logout(request.principal, this.correlation(request));
    this.clearCookies(response);
  }

  /** Завершает все сессии пользователя на всех backend replicas. */
  @Post('logout-all')
  @HttpCode(200)
  @UseGuards(HumanSessionGuard, CsrfGuard)
  @ApiSecurity('SessionCookie')
  async logoutAll(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<{ revokedCount: number }> {
    const revokedCount = await this.identity.logoutAll(
      request.principal,
      this.correlation(request),
    );
    this.clearCookies(response);
    return { revokedCount };
  }

  /** Запускает verification без возврата reusable token. */
  @Post('email-verification/request')
  @HttpCode(202)
  async requestVerification(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(challengeSchema)) body: z.infer<typeof challengeSchema>,
  ): Promise<{ accepted: true }> {
    this.rateLimit(request, body.email);
    await this.identity.requestChallenge('EMAIL_VERIFY', body.email);
    return { accepted: true };
  }
  /** Однократно поглощает verification token. */
  @Post('email-verification/confirm') @HttpCode(204) async verify(
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: z.infer<typeof verifyEmailSchema>,
  ): Promise<void> {
    await this.identity.confirmEmail(body.token);
  }
  /** Всегда принимает reset request, независимо от существования email. */
  @Post('password-reset/request') @HttpCode(202) async requestReset(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(challengeSchema)) body: z.infer<typeof challengeSchema>,
  ): Promise<{ accepted: true }> {
    this.rateLimit(request, body.email);
    await this.identity.requestChallenge('PASSWORD_RESET', body.email);
    return { accepted: true };
  }
  /** Однократно меняет password и отзывает все старые sessions. */
  @Post('password-reset/confirm') @HttpCode(204) async reset(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ): Promise<void> {
    await this.identity.resetPassword(body.token, body.newPassword, this.correlation(request));
  }

  private respondWithSession(
    response: HttpResponse,
    result: SessionIssueResult,
  ): AuthenticationResponseDto {
    this.setCookies(response, result);
    return { user: result.user, session: result.session };
  }
  private setCookies(response: HttpResponse, result: SessionIssueResult): void {
    const secure = this.config.get('AUTH_COOKIE_SECURE', 'false') === 'true';
    const sameSite = this.config.get<string>('AUTH_COOKIE_SAME_SITE', 'Strict');
    const maxAge = Number(this.config.get('AUTH_SESSION_IDLE_TTL_SECONDS', '1800'));
    const suffix = `Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=${sameSite}${secure ? '; Secure' : ''}`;
    const csrfSuffix = `Path=/; Max-Age=${maxAge}; SameSite=${sameSite}${secure ? '; Secure' : ''}`;
    response.header('Set-Cookie', [
      `${this.config.get('AUTH_COOKIE_NAME', 'exchange_session')}=${result.token}; ${suffix}`,
      `${this.config.get('AUTH_CSRF_COOKIE_NAME', 'exchange_csrf')}=${this.csrf.token(result.session.sessionId)}; ${csrfSuffix}`,
    ]);
  }
  private clearCookies(response: HttpResponse): void {
    response.header('Set-Cookie', [
      `${this.config.get('AUTH_COOKIE_NAME', 'exchange_session')}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict`,
      `${this.config.get('AUTH_CSRF_COOKIE_NAME', 'exchange_csrf')}=; Path=/; Max-Age=0; SameSite=Strict`,
    ]);
  }
  private rateLimit(request: HttpRequest, subject: string): void {
    this.limiter.check(
      createHash('sha256')
        .update(`${request.ip ?? 'unknown'}:${subject.trim().toLowerCase()}`)
        .digest('hex'),
    );
  }
  private correlation(request: HttpRequest): string {
    const value = request.headers['x-correlation-id'];
    return (Array.isArray(value) ? value[0] : value)?.slice(0, 128) || randomUUID();
  }
  private context(request: HttpRequest, deviceLabel: string): SessionContext {
    const ua = request.headers['user-agent'];
    return {
      correlationId: this.correlation(request),
      deviceLabel,
      userAgent: (Array.isArray(ua) ? ua[0] : ua) ?? '',
      ip: request.ip ?? '',
    };
  }
}
