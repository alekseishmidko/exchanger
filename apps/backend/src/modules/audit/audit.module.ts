import { Module } from '@nestjs/common';
import { AuditLog } from './audit-log';

/** Composition root append-only audit boundary. */
@Module({ providers: [AuditLog], exports: [AuditLog] })
export class AuditModule {}
