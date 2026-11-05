import { Module, forwardRef } from '@nestjs/common';
import { ReleaseAssemblerService } from './release-assembler.service';
import { PublishingRepository } from './publishing.repository';
import { ScheduleArtifactProvider } from './providers/schedule-artifact.provider';
import { FormArtifactProvider } from './providers/form-artifact.provider';
import { EventsModule } from '../events/events.module';

@Module({
  imports: [forwardRef(() => EventsModule)],
  providers: [
    ReleaseAssemblerService,
    PublishingRepository,
    ScheduleArtifactProvider,
    FormArtifactProvider,
  ],
  exports: [
    ReleaseAssemblerService,
    PublishingRepository,
    ScheduleArtifactProvider,
    FormArtifactProvider,
  ],
})
export class PublishingModule {}

