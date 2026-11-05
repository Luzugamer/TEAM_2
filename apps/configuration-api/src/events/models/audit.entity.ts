export interface AuditEntity {
  id: string; // UUIDv7
  organization_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_roles: string[];
  request_id: string | null;
  idempotency_key: string | null;
  revision_number: number | null;
  diff: Record<string, unknown> | null;
  payload_hash: string | null;
  client_ip: string | null;
  user_agent: string | null;
  created_at: string;
}

