import { ColumnType, Generated } from 'kysely';

export interface EventsTable {
  id: Generated<string>;
  organization_id: string;
  site_id: string;
  slug: string;
  kind: string;
  title: string;
  description: string | null;
  timezone: string;
  starts_at: ColumnType<Date, Date | string, Date | string>;
  ends_at: ColumnType<Date, Date | string, Date | string>;
  status: 'draft' | 'published' | 'closed' | 'cancelled' | 'archived';
  current_revision_id: string | null;
  revision_number: ColumnType<number, number | undefined, number>;
  policy: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  cancellation_reason: string | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface EventRevisionsTable {
  id: Generated<string>;
  organization_id: string;
  event_id: string;
  revision_number: number;
  snapshot: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  change_summary: string | null;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AssignmentsTable {
  id: Generated<string>;
  organization_id: string;
  event_id: string | null;
  site_id: string | null;
  user_id: string;
  role: string;
  scopes: string[];
  valid_from: ColumnType<Date, Date | string | undefined, Date | string>;
  valid_to: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  is_active: ColumnType<boolean, boolean | undefined, boolean>;
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ReleasesTable {
  id: Generated<string>;
  organization_id: string;
  event_id: string;
  release_version: number;
  effective_at: ColumnType<Date, Date | string, Date | string>;
  manifest_ref: string;
  manifest_hash: string;
  manifest: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  event_revision_number: number;
  status: 'published' | 'superseded' | 'cancelled';
  created_by: string;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ReleaseArtifactsTable {
  id: Generated<string>;
  organization_id: string;
  release_id: string;
  event_id: string;
  kind: 'event' | 'schedule' | 'forms';
  version: string;
  artifact_ref: string;
  sha256: string;
  body: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface ReleaseConsumersTable {
  id: Generated<string>;
  organization_id: string;
  release_id: string;
  consumer_name: string;
  consumer_version: string | null;
  status: 'pending' | 'active' | 'failed' | 'unknown';
  acknowledged_at: Date | null;
  last_error: string | null;
  lag_ms: number | null;
  metadata: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface AuditTable {
  id: Generated<string>;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_roles: string[];
  request_id: string | null;
  idempotency_key: string | null;
  revision_number: number | null;
  diff: ColumnType<Record<string, unknown> | null, Record<string, unknown> | string | null, Record<string, unknown> | string | null>;
  payload_hash: string | null;
  client_ip: string | null;
  user_agent: string | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface OutboxTable {
  id: Generated<string>;
  organization_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  headers: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  status: 'pending' | 'delivered' | 'failed';
  retry_count: ColumnType<number, number | undefined, number>;
  max_retries: ColumnType<number, number | undefined, number>;
  next_retry_at: ColumnType<Date, Date | string | undefined, Date | string>;
  delivered_at: Date | null;
  last_error: string | null;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface IdempotencyRecordsTable {
  id: Generated<string>;
  organization_id: string;
  actor_id: string;
  operation: string;
  idempotency_key: string;
  request_path: string;
  request_hash: string;
  response_code: number;
  response_headers: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  response_body: ColumnType<Record<string, unknown>, Record<string, unknown> | string, Record<string, unknown> | string>;
  created_at: ColumnType<Date, Date | string | undefined, Date | string>;
  expires_at: ColumnType<Date, Date | string | undefined, Date | string>;
}

export interface DatabaseSchema {
  events: EventsTable;
  event_revisions: EventRevisionsTable;
  assignments: AssignmentsTable;
  releases: ReleasesTable;
  release_artifacts: ReleaseArtifactsTable;
  release_consumers: ReleaseConsumersTable;
  audit: AuditTable;
  outbox: OutboxTable;
  idempotency_records: IdempotencyRecordsTable;
}
