-- Migration: 0001_initial_events_and_publishing.sql
-- Description: Base schema for Team 2 Event Configuration (Integrante A - Events & Publishing Core)
-- Tables: events, event_revisions, assignments, releases, release_artifacts, release_consumers, audit, outbox, idempotency_records
-- Author: Integrante A (Eventos y núcleo de publicación)

-- 1. UUIDv7 generation support (pure PL/pgSQL RFC 9562 compatible)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE OR REPLACE FUNCTION generate_uuid_v7()
RETURNS uuid AS $$
DECLARE
    unix_time_ms bigint;
    uuid_bytes bytea;
BEGIN
    unix_time_ms := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
    
    -- 16 random bytes
    uuid_bytes := gen_random_bytes(16);

    -- 48 bits (6 bytes) for unix_time_ms in network byte order
    uuid_bytes := set_byte(uuid_bytes, 0, (unix_time_ms >> 40)::bit(8)::integer);
    uuid_bytes := set_byte(uuid_bytes, 1, (unix_time_ms >> 32)::bit(8)::integer);
    uuid_bytes := set_byte(uuid_bytes, 2, (unix_time_ms >> 24)::bit(8)::integer);
    uuid_bytes := set_byte(uuid_bytes, 3, (unix_time_ms >> 16)::bit(8)::integer);
    uuid_bytes := set_byte(uuid_bytes, 4, (unix_time_ms >> 8)::bit(8)::integer);
    uuid_bytes := set_byte(uuid_bytes, 5, unix_time_ms::bit(8)::integer);

    -- 4 bits version '0111' (UUIDv7) in byte 6
    uuid_bytes := set_byte(uuid_bytes, 6, (get_byte(uuid_bytes, 6) & 15) | 112);
    -- 2 bits variant '10' (RFC 4122) in byte 8
    uuid_bytes := set_byte(uuid_bytes, 8, (get_byte(uuid_bytes, 8) & 63) | 128);

    RETURN encode(uuid_bytes, 'hex')::uuid;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- 2. Tenant Context Helper Function for Row Level Security
CREATE OR REPLACE FUNCTION current_app_organization_id()
RETURNS uuid AS $$
BEGIN
    RETURN NULLIF(current_setting('app.current_organization_id', true), '')::uuid;
EXCEPTION
    WHEN OTHERS THEN
        RETURN NULL;
END;
$$ LANGUAGE plpgsql STABLE;

-- 3. Table: events
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    site_id UUID NOT NULL,
    slug VARCHAR(120) NOT NULL,
    kind VARCHAR(50) NOT NULL,
    title VARCHAR(255) NOT NULL,
    description TEXT,
    timezone VARCHAR(64) NOT NULL,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'draft',
    current_revision_id UUID,
    revision_number INT NOT NULL DEFAULT 1,
    policy JSONB NOT NULL DEFAULT '{}'::jsonb,
    cancellation_reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_events_dates CHECK (starts_at < ends_at),
    CONSTRAINT chk_events_status CHECK (status IN ('draft', 'published', 'closed', 'cancelled', 'archived')),
    CONSTRAINT uq_events_org_site_slug UNIQUE (organization_id, site_id, slug),
    CONSTRAINT uq_events_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_events_org_site_status ON events(organization_id, site_id, status);
CREATE INDEX IF NOT EXISTS idx_events_org_starts_at ON events(organization_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_events_org_slug ON events(organization_id, slug);

ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE events FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS events_tenant_isolation ON events;
CREATE POLICY events_tenant_isolation ON events
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- 4. Table: event_revisions
CREATE TABLE IF NOT EXISTS event_revisions (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    event_id UUID NOT NULL,
    revision_number INT NOT NULL,
    snapshot JSONB NOT NULL,
    change_summary TEXT,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT fk_event_revisions_event FOREIGN KEY (organization_id, event_id)
        REFERENCES events(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_event_revisions_org_event_rev UNIQUE (organization_id, event_id, revision_number),
    CONSTRAINT uq_event_revisions_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_event_revisions_lookup ON event_revisions(organization_id, event_id, revision_number DESC);

ALTER TABLE event_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_revisions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS event_revisions_tenant_isolation ON event_revisions;
CREATE POLICY event_revisions_tenant_isolation ON event_revisions
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- Foreign key update on events to point to event_revisions
ALTER TABLE events
    DROP CONSTRAINT IF EXISTS fk_events_current_revision,
    ADD CONSTRAINT fk_events_current_revision FOREIGN KEY (organization_id, current_revision_id)
        REFERENCES event_revisions(organization_id, id) ON DELETE SET NULL;

-- 5. Table: assignments (Site and Event-level roles)
CREATE TABLE IF NOT EXISTS assignments (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    event_id UUID,
    site_id UUID,
    user_id UUID NOT NULL,
    role VARCHAR(50) NOT NULL,
    scopes TEXT[] NOT NULL DEFAULT '{}',
    valid_from TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    valid_to TIMESTAMPTZ,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_assignments_dates CHECK (valid_to IS NULL OR valid_from < valid_to),
    CONSTRAINT fk_assignments_event FOREIGN KEY (organization_id, event_id)
        REFERENCES events(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_assignments_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_assignments_org_event_user ON assignments(organization_id, event_id, user_id);
CREATE INDEX IF NOT EXISTS idx_assignments_org_site_user ON assignments(organization_id, site_id, user_id);

ALTER TABLE assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE assignments FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS assignments_tenant_isolation ON assignments;
CREATE POLICY assignments_tenant_isolation ON assignments
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- 6. Table: releases (Publication manifests)
CREATE TABLE IF NOT EXISTS releases (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    event_id UUID NOT NULL,
    release_version INT NOT NULL,
    effective_at TIMESTAMPTZ NOT NULL,
    manifest_ref VARCHAR(255) NOT NULL,
    manifest_hash CHAR(64) NOT NULL,
    manifest JSONB NOT NULL,
    event_revision_number INT NOT NULL,
    status VARCHAR(30) NOT NULL DEFAULT 'published',
    created_by VARCHAR(255) NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_releases_status CHECK (status IN ('published', 'superseded', 'cancelled')),
    CONSTRAINT fk_releases_event FOREIGN KEY (organization_id, event_id)
        REFERENCES events(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_releases_org_event_version UNIQUE (organization_id, event_id, release_version),
    CONSTRAINT uq_releases_org_manifest_ref UNIQUE (organization_id, manifest_ref),
    CONSTRAINT uq_releases_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_releases_org_event_version ON releases(organization_id, event_id, release_version DESC);
CREATE INDEX IF NOT EXISTS idx_releases_org_manifest_ref ON releases(organization_id, manifest_ref);

ALTER TABLE releases ENABLE ROW LEVEL SECURITY;
ALTER TABLE releases FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS releases_tenant_isolation ON releases;
CREATE POLICY releases_tenant_isolation ON releases
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- 7. Table: release_artifacts (Immutable snapshot artifacts: event, schedule, forms)
CREATE TABLE IF NOT EXISTS release_artifacts (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    release_id UUID NOT NULL,
    event_id UUID NOT NULL,
    kind VARCHAR(50) NOT NULL,
    version VARCHAR(50) NOT NULL,
    artifact_ref VARCHAR(255) NOT NULL,
    sha256 CHAR(64) NOT NULL,
    body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_release_artifacts_kind CHECK (kind IN ('event', 'schedule', 'forms')),
    CONSTRAINT fk_release_artifacts_release FOREIGN KEY (organization_id, release_id)
        REFERENCES releases(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_release_artifacts_event FOREIGN KEY (organization_id, event_id)
        REFERENCES events(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_release_artifacts_org_release_kind UNIQUE (organization_id, release_id, kind),
    CONSTRAINT uq_release_artifacts_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_release_artifacts_org_release ON release_artifacts(organization_id, release_id);
CREATE INDEX IF NOT EXISTS idx_release_artifacts_org_event_kind ON release_artifacts(organization_id, event_id, kind);

ALTER TABLE release_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_artifacts FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS release_artifacts_tenant_isolation ON release_artifacts;
CREATE POLICY release_artifacts_tenant_isolation ON release_artifacts
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- 8. Table: release_consumers (Consumer propagation and ACK tracking)
CREATE TABLE IF NOT EXISTS release_consumers (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    release_id UUID NOT NULL,
    consumer_name VARCHAR(100) NOT NULL,
    consumer_version VARCHAR(50),
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    acknowledged_at TIMESTAMPTZ,
    last_error TEXT,
    lag_ms BIGINT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_release_consumers_status CHECK (status IN ('pending', 'active', 'failed', 'unknown')),
    CONSTRAINT fk_release_consumers_release FOREIGN KEY (organization_id, release_id)
        REFERENCES releases(organization_id, id) ON DELETE CASCADE,
    CONSTRAINT uq_release_consumers_org_release_consumer UNIQUE (organization_id, release_id, consumer_name),
    CONSTRAINT uq_release_consumers_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_release_consumers_org_release_status ON release_consumers(organization_id, release_id, status);

ALTER TABLE release_consumers ENABLE ROW LEVEL SECURITY;
ALTER TABLE release_consumers FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS release_consumers_tenant_isolation ON release_consumers;
CREATE POLICY release_consumers_tenant_isolation ON release_consumers
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- 9. Table: audit (Append-only audit trail)
CREATE TABLE IF NOT EXISTS audit (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    entity_type VARCHAR(50) NOT NULL,
    entity_id UUID NOT NULL,
    action VARCHAR(50) NOT NULL,
    actor_id VARCHAR(255) NOT NULL,
    actor_roles TEXT[] NOT NULL DEFAULT '{}',
    request_id VARCHAR(255),
    idempotency_key VARCHAR(255),
    revision_number INT,
    diff JSONB,
    payload_hash CHAR(64),
    client_ip VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT uq_audit_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_audit_org_entity ON audit(organization_id, entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_org_created_at ON audit(organization_id, created_at DESC);

ALTER TABLE audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS audit_tenant_isolation ON audit;
CREATE POLICY audit_tenant_isolation ON audit
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- Append-only trigger preventing UPDATE and DELETE on audit log
CREATE OR REPLACE FUNCTION prevent_audit_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Audit log is append-only. Modification or deletion is strictly forbidden.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit;
CREATE TRIGGER trg_audit_immutable
    BEFORE UPDATE OR DELETE ON audit
    FOR EACH ROW
    EXECUTE FUNCTION prevent_audit_modification();

-- 10. Table: outbox (Transactional Outbox for domain events)
CREATE TABLE IF NOT EXISTS outbox (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    event_type VARCHAR(100) NOT NULL,
    aggregate_type VARCHAR(50) NOT NULL,
    aggregate_id UUID NOT NULL,
    payload JSONB NOT NULL,
    headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    status VARCHAR(30) NOT NULL DEFAULT 'pending',
    retry_count INT NOT NULL DEFAULT 0,
    max_retries INT NOT NULL DEFAULT 5,
    next_retry_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    delivered_at TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    CONSTRAINT chk_outbox_status CHECK (status IN ('pending', 'delivered', 'failed')),
    CONSTRAINT uq_outbox_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_outbox_pending_dispatch ON outbox(status, next_retry_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_outbox_org_aggregate ON outbox(organization_id, aggregate_type, aggregate_id);

ALTER TABLE outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outbox_tenant_isolation ON outbox;
CREATE POLICY outbox_tenant_isolation ON outbox
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

-- 11. Table: idempotency_records (Transactional Idempotency)
CREATE TABLE IF NOT EXISTS idempotency_records (
    id UUID PRIMARY KEY DEFAULT generate_uuid_v7(),
    organization_id UUID NOT NULL,
    idempotency_key VARCHAR(255) NOT NULL,
    request_path VARCHAR(255) NOT NULL,
    request_hash CHAR(64) NOT NULL,
    response_code INT NOT NULL,
    response_headers JSONB NOT NULL DEFAULT '{}'::jsonb,
    response_body JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    expires_at TIMESTAMPTZ NOT NULL DEFAULT (clock_timestamp() + INTERVAL '24 hours'),
    CONSTRAINT uq_idempotency_org_key UNIQUE (organization_id, idempotency_key),
    CONSTRAINT uq_idempotency_records_org_id UNIQUE (organization_id, id)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_lookup ON idempotency_records(organization_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_idempotency_records_expires ON idempotency_records(expires_at);

ALTER TABLE idempotency_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_records FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_records_tenant_isolation ON idempotency_records;
CREATE POLICY idempotency_records_tenant_isolation ON idempotency_records
    FOR ALL
    USING (organization_id = current_app_organization_id())
    WITH CHECK (organization_id = current_app_organization_id());

