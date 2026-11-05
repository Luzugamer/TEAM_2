import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './shared/database/database.module';
import { IdempotencyModule } from './shared/idempotency/idempotency.module';
import { EventsModule } from './events/events.module';
import { PublishingModule } from './publishing/publishing.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    DatabaseModule,
    IdempotencyModule,
    EventsModule,
    PublishingModule,
  ],
})
export class AppModule {}

