import { Module } from '@nestjs/common';
import { AuditModule } from '../audit';
import { AdminService } from './admin.service';

/** Composition root административного сервиса и tamper-evident audit dependency. */
@Module({ imports: [AuditModule], providers: [AdminService], exports: [AdminService] })
export class AdminModule {}
