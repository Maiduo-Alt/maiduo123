import 'reflect-metadata';
import express from 'express';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/all-exceptions.filter';
import { ResponseInterceptor } from './common/response.interceptor';
import { loadEnv } from './db/env';
import { DbService, isMemoryDb } from './db/db.service';
import { runMigrations } from './db/migrate';
import { runSeed } from './db/seed';
import { uploadDir } from './modules/uploads/uploads.service';

async function bootstrap(): Promise<void> {
  loadEnv();
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalPipes(new ValidationPipe({ transform: true, whitelist: false }));
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.enableCors({ origin: true, credentials: true });
  // 上传的图片按静态资源对外提供（方案 3.4 商品主图/详情图）
  app.use('/uploads', express.static(uploadDir()));

  if (isMemoryDb()) {
    const db = app.get(DbService);
    await runMigrations(db);
    const stats = await runSeed(db);
    Logger.log(`内存数据库初始化完成：商品 ${stats.products} 个、背景 ${stats.backgrounds} 条、咨询内容 ${stats.contents} 条、剧本 ${stats.scripts} 个`, 'Bootstrap');
  }

  /**
   * 方案 5.10：worker 容器复用 api 镜像，只跑延迟队列 / 超时检测 / 异步导入，不接 HTTP。
   * `WORKER_ONLY=true` 时只 init（触发各模块的 onModuleInit：调度器、定时扫描），不 listen 端口。
   * 这样 nginx 只会把请求发给 api 容器，worker 不被外部访问。
   */
  if (String(process.env.WORKER_ONLY || '').toLowerCase() === 'true') {
    await app.init();
    Logger.log('Worker 模式启动：只跑调度与后台任务，不监听 HTTP 端口', 'Bootstrap');
    return;
  }

  const port = Number(process.env.PORT || 3000);
  await app.listen(port);
  Logger.log(`API 服务已启动: http://localhost:${port}`, 'Bootstrap');
}

bootstrap();
