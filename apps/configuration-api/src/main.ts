import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { ProblemDetailsFilter } from './shared/errors/problem-details.filter';
import { generateUuidV7 } from './shared/crypto/uuidv7';

async function bootstrap() {
  if (process.env.AUTH_MODE === 'mock' && process.env.NODE_ENV !== 'development') {
    throw new Error('AUTH_MODE=mock is allowed only with NODE_ENV=development.');
  }
  if (process.env.AUTH_MODE !== 'mock') {
    throw new Error('A verified identity provider is not configured; set AUTH_MODE=mock for local development.');
  }
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule);

  app.use((request: Request, response: Response, next: NextFunction) => {
    const suppliedId = request.header('x-request-id');
    const isUuid = suppliedId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suppliedId);
    const requestId = isUuid && suppliedId ? suppliedId : generateUuidV7();
    request.headers['x-request-id'] = requestId;
    response.setHeader('X-Request-Id', requestId);
    next();
  });

  // Global prefix for Configuration API v1
  app.setGlobalPrefix('configuration/v1');

  // RFC 7807 / RFC 9457 Problem Details Exception Filter
  app.useGlobalFilters(new ProblemDetailsFilter());

  // Input Validation with class-validator
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  // Enable CORS
  app.enableCors({
    origin: '*',
    exposedHeaders: ['ETag', 'Idempotency-Key', 'Content-Type', 'X-Request-Id'],
  });

  // Swagger Documentation Setup
  const config = new DocumentBuilder()
    .setTitle('Event Configuration API - Module A (Events & Publishing)')
    .setDescription('Event lifecycle, revisions, publication assembler, and outbox core')
    .setVersion('1.0.0')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'x-dev-actor', description: 'Development fixtures only' }, 'DevActor')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('configuration/v1/docs', app, document);

  const port = process.env.PORT || 3000;
  await app.listen(port);
  logger.log(`Configuration API running at http://localhost:${port}/configuration/v1`);
  logger.log(`OpenAPI documentation available at http://localhost:${port}/configuration/v1/docs`);
}

bootstrap();

