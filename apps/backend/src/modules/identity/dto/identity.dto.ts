import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Запрос регистрации; неизвестные поля отклоняются runtime schema. */
export class RegisterRequestDto {
  @ApiProperty({ example: 'user@example.test' }) email!: string;
  @ApiProperty({ minLength: 12, example: 'correct horse battery staple' }) password!: string;
  @ApiProperty({ example: 'Example User' }) name!: string;
}
/** Запрос password login. */
export class LoginRequestDto {
  @ApiProperty({ example: 'user@example.test' }) email!: string;
  @ApiProperty({ minLength: 12 }) password!: string;
  @ApiPropertyOptional({ example: 'Chrome on Linux' }) deviceLabel?: string;
}
/** Безопасный публичный профиль без hash, roles и security flags. */
export class PublicUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() name!: string;
  @ApiProperty() emailVerified!: boolean;
  @ApiProperty() createdAt!: string;
}
/** Allow-listed metadata server session без token/digest/Redis key. */
export class PublicSessionDto {
  @ApiProperty() sessionId!: string;
  @ApiProperty() current!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() lastSeenAt!: string;
  @ApiProperty() expiresAt!: string;
  @ApiProperty({ nullable: true }) revokedAt!: string | null;
  @ApiProperty() deviceLabel!: string;
}
/** Login/register response; credential передаётся только Set-Cookie. */
export class AuthenticationResponseDto {
  @ApiProperty({ type: PublicUserDto }) user!: PublicUserDto;
  @ApiProperty({ type: PublicSessionDto }) session!: PublicSessionDto;
}
/** Текущая identity и вычисленные capabilities, без внутренних roles. */
export class CurrentUserResponseDto {
  @ApiProperty({ type: PublicUserDto }) user!: PublicUserDto;
  @ApiProperty({ type: [String] }) capabilities!: string[];
}
/** Self-service изменение разрешённого поля name. */
export class UpdateProfileRequestDto {
  @ApiProperty({ minLength: 1, maxLength: 120 }) name!: string;
}
/** Смена password с re-auth и опцией отзыва остальных sessions. */
export class ChangePasswordRequestDto {
  @ApiProperty() currentPassword!: string;
  @ApiProperty({ minLength: 12 }) newPassword!: string;
  @ApiProperty({ default: true }) logoutOtherSessions!: boolean;
}
/** Enumeration-resistant начало email challenge. */
export class ChallengeRequestDto {
  @ApiProperty() email!: string;
}
/** Одноразовое подтверждение token; token никогда не отражается в response. */
export class VerifyEmailRequestDto {
  @ApiProperty() token!: string;
}
/** Одноразовое восстановление password. */
export class ResetPasswordRequestDto {
  @ApiProperty() token!: string;
  @ApiProperty({ minLength: 12 }) newPassword!: string;
}
/** Обязательное обоснование привилегированной операции. */
export class AdminSessionActionRequestDto {
  @ApiProperty({
    enum: ['security_incident', 'user_request', 'credential_compromise', 'policy_enforcement'],
  })
  reason!: string;
}
