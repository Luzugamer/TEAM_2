import { Kysely } from 'kysely';
import { DatabaseSchema } from '../../shared/database/types';
import { EventStatus } from '../../events/models/event-status.enum';

export interface PublicationContext {
  organization_id: string;
  event_id: string;
  expected_event_revision: number;
  effective_at: string;
  target_status?: EventStatus.PUBLISHED | EventStatus.CLOSED | EventStatus.CANCELLED;
  transaction?: Kysely<DatabaseSchema>;
}

