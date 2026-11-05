export interface EventRevisionEntity {
  id: string;
  organization_id: string;
  event_id: string;
  revision_number: number;
  snapshot: Record<string, unknown>;
  change_summary: string | null;
  created_by: string;
  created_at: string;
}

