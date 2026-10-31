import 'reflect-metadata';
import * as path from 'path';
import { config as loadDotenv } from 'dotenv';

// 必须在 AppModule（其中会读取环境变量）被加载之前执行
loadDotenv({ path: path.resolve(__dirname, '../../../.env') });

async function bootstrap() {
  const { NestFactory } = await import('@nestjs/core');
  const { ValidationPipe } = await import('@nestjs/common');
  const { default: helmet } = await import('helmet');
  const { AppModule } = await import('./app.module');
  const { loadEnv } = await import('./config/env');

  const env = loadEnv();
  const app = await NestFactory.create(AppModule);
  const { json } = await import('express');
  app.use('/api/collector/file', json({ limit: '6mb' }));
  app.use(helmet());
  app.setGlobalPrefix('api');
  app.enableCors({ origin: env.corsOrigin.split(','), credentials: false });
  // 只接受 DTO 里声明过的字段，多余字段直接拒绝
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(env.apiPort);
  // eslint-disable-next-line no-console
  console.log(`API 已启动：http://localhost:${env.apiPort}/api/health`);
}

void bootstrap();
