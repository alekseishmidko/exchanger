/**
 * HTTP boundary регистрации, login/logout и credential recovery.
 *
 * Контроллер выполняет только transport orchestration: Zod validation →
 * anti-abuse limits → application service → безопасные response cookies/DTO.
 * Password, raw session token и recovery token не попадают в response body.
 */
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
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ZodValidationPipe } from '../../gateway/validation/gateway.validation';
import {
  HumanAuthService,
  SessionContext,
  SessionIssueResult,
} from '../application/human-auth.service';
import {
  AuthenticationResponseDto,
  CurrentUserResponseDto,
  LoginRequestDto,
  RegisterRequestDto,
} from '../dto/human-auth.dto';
import { CsrfGuard } from '../security/csrf.guard';
import { CookieResponse, SessionCookieService } from '../security/session-cookie.service';
import { HumanAuthenticatedRequest, HumanSessionGuard } from '../security/human-session.guard';
import { AuthRateLimit } from '../security/auth-rate-limit';
import {
  challengeSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '../validation/human-auth.validation';

type HttpRequest = HumanAuthenticatedRequest & {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
};
type HttpResponse = CookieResponse;

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
  /**
   * @param identity Human-auth application use cases без зависимости от HTTP.
   * @param limiter Многоуровневый limiter по IP, account subject и global bucket.
   * @param cookies Единственная точка сериализации session/CSRF cookies.
   */
  constructor(
    private readonly identity: HumanAuthService,
    private readonly limiter: AuthRateLimit,
    private readonly cookies: SessionCookieService,
  ) {}

  /**
   * Валидирует registration payload, применяет anti-abuse buckets и создаёт user/session.
   * Raw session token передаётся напрямую cookie adapter и не включается в DTO.
   */
  @Post('register')
  @ApiOperation({ summary: 'Зарегистрировать пользователя' })
  @ApiBody({ type: RegisterRequestDto })
  @ApiCreatedResponse({ type: AuthenticationResponseDto })
  async register(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
    @Body(new ZodValidationPipe(registerSchema)) body: z.infer<typeof registerSchema>,
  ): Promise<AuthenticationResponseDto> {
    await this.rateLimit(request, body.email);
    return this.respondWithSession(
      response,
      await this.identity.register(body, this.context(request, 'new device')),
    );
  }

  /**
   * Аутентифицирует password без раскрытия причины отказа и предотвращает fixation.
   * Каждый успешный login получает новый opaque session identifier независимо от cookies запроса.
   */
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
    await this.rateLimit(request, body.email);
    return this.respondWithSession(
      response,
      await this.identity.login(body, this.context(request, body.deviceLabel ?? 'unknown device')),
    );
  }

  /** Возвращает allow-listed profile после live проверки cookie через HumanSessionGuard. */
  @Get('me')
  @UseGuards(HumanSessionGuard)
  @ApiSecurity('SessionCookie')
  @ApiOkResponse({ type: CurrentUserResponseDto })
  me(@Req() request: HttpRequest): Promise<CurrentUserResponseDto> {
    return this.identity
      .me(request.principal)
      .then((value) => ({ user: value.user, capabilities: [...value.capabilities] }));
  }

  /** После session+CSRF guards отзывает текущую server session и очищает обе cookies. */
  @Post('logout')
  @HttpCode(204)
  @UseGuards(HumanSessionGuard, CsrfGuard)
  @ApiSecurity('SessionCookie')
  async logout(
    @Req() request: HttpRequest,
    @Res({ passthrough: true }) response: HttpResponse,
  ): Promise<void> {
    await this.identity.logout(request.principal, this.correlation(request));
    this.cookies.clear(response);
  }

  /** Отзывает все server sessions пользователя и очищает credential текущего browser. */
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
    this.cookies.clear(response);
    return { revokedCount };
  }

  /** Принимает verification request одинаково для существующего и неизвестного email. */
  @Post('email-verification/request')
  @HttpCode(202)
  async requestVerification(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(challengeSchema)) body: z.infer<typeof challengeSchema>,
  ): Promise<{ accepted: true }> {
    await this.rateLimit(request, body.email);
    await this.identity.requestChallenge('EMAIL_VERIFY', body.email);
    return { accepted: true };
  }
  /** Проверяет rate limit и однократно поглощает verification token. */
  @Post('email-verification/confirm') @HttpCode(204) async verify(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(verifyEmailSchema)) body: z.infer<typeof verifyEmailSchema>,
  ): Promise<void> {
    await this.rateLimit(request, 'email-verification-confirm');
    await this.identity.confirmEmail(body.token);
  }
  /** Всегда возвращает accepted, независимо от существования email или результата delivery. */
  @Post('password-reset/request') @HttpCode(202) async requestReset(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(challengeSchema)) body: z.infer<typeof challengeSchema>,
  ): Promise<{ accepted: true }> {
    await this.rateLimit(request, body.email);
    await this.identity.requestChallenge('PASSWORD_RESET', body.email);
    return { accepted: true };
  }
  /** Поглощает reset token, меняет password и отзывает все старые sessions. */
  @Post('password-reset/confirm') @HttpCode(204) async reset(
    @Req() request: HttpRequest,
    @Body(new ZodValidationPipe(resetPasswordSchema)) body: z.infer<typeof resetPasswordSchema>,
  ): Promise<void> {
    await this.rateLimit(request, 'password-reset-confirm');
    await this.identity.resetPassword(body.token, body.newPassword, this.correlation(request));
  }

  /** Устанавливает credential cookies и возвращает только allow-listed user/session metadata. */
  private respondWithSession(
    response: HttpResponse,
    result: SessionIssueResult,
  ): AuthenticationResponseDto {
    this.cookies.set(response, result);
    return { user: result.user, session: result.session };
  }
  /**
   * Хеширует IP/account до передачи limiter-у и проверяет три независимых bucket.
   * Это ограничивает credential stuffing без хранения исходных PII в ключах Redis.
   */
  private rateLimit(request: HttpRequest, subject: string): Promise<void> {
    const digest = (kind: string, value: string): string =>
      createHash('sha256').update(`${kind}\u0000${value}`).digest('hex');
    return this.limiter.check([
      `ip:${digest('ip', request.ip ?? 'unknown')}`,
      `account:${digest('account', subject.trim().toLowerCase())}`,
      'global',
    ]);
  }
  /** Принимает bounded correlation id клиента либо создаёт server-generated UUID. */
  private correlation(request: HttpRequest): string {
    const value = request.headers['x-correlation-id'];
    return (Array.isArray(value) ? value[0] : value)?.slice(0, 128) || randomUUID();
  }
  /** Собирает минимальный device context; application service сохранит только его digests. */
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
