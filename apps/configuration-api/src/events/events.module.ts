import { Module, forwardRef } from '@nestjs/common';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventsRepository } from './events.repository';
import { MembershipAdapter } from './membership.adapter';
import { AuthGuard, CLAIMS_PROVIDER, MockClaimsProvider } from '../shared/auth/auth.guard';
import { PublishingModule } from '../publishing/publishing.module';

@Module({
  imports: [forwardRef(() => PublishingModule)],
  controllers: [EventsController],
  providers: [EventsService, EventsRepository, MembershipAdapter, AuthGuard, { provide: CLAIMS_PROVIDER, useClass: MockClaimsProvider }],
  exports: [EventsService, EventsRepository, MembershipAdapter],
})
export class EventsModule {}

