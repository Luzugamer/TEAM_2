ALTER TABLE outbox
    ADD COLUMN locked_by VARCHAR(255),
    ADD COLUMN locked_until TIMESTAMPTZ;

CREATE INDEX idx_outbox_claimable_tenant
    ON outbox (organization_id, next_retry_at, created_at)
    WHERE status = 'pending';
