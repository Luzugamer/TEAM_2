import { EventRevisionEntity } from '../models/event-revision.entity';
import { AuditResponseDto } from './audit-response.dto';

export class EventHistoryResponseDto {
  event_id!: string;
  organization_id!: string;
  current_revision!: number;
  revisions!: EventRevisionEntity[];
  audit_trail!: AuditResponseDto[];
}

