import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { DbModule } from './db/db.module';
import { AuthModule } from './modules/auth/auth.module';
import { SettingsModule } from './modules/settings/settings.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { ProductsModule } from './modules/products/products.module';
import { MaterialsModule } from './modules/materials/materials.module';
import { ScriptsModule } from './modules/scripts/scripts.module';
import { StylesModule } from './modules/styles/styles.module';
import { PhrasesModule } from './modules/phrases/phrases.module';
import { ReceptionModule } from './modules/reception/reception.module';
import { RecordsModule } from './modules/records/records.module';
import { CasesModule } from './modules/cases/cases.module';
import { TasksModule } from './modules/tasks/tasks.module';
import { UploadsModule } from './modules/uploads/uploads.module';
import { AuthGuard } from './common/auth.guard';
import { AuditInterceptor } from './common/audit.interceptor';
import { HealthModule } from './modules/health/health.module';

@Module({
  imports: [
    DbModule,
    AuthModule,
    SettingsModule,
    AccountsModule,
    ProductsModule,
    MaterialsModule,
    ScriptsModule,
    StylesModule,
    PhrasesModule,
    TasksModule,
    CasesModule,
    ReceptionModule,
    RecordsModule,
    UploadsModule,
    // 方案 5.10：健康检查 /api/health
    HealthModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    // 方案 5.11：操作类接口写审计日志（对所有写操作生效，含测试环境）
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
