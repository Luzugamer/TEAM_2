ALTER TABLE idempotency_records
    ADD COLUMN actor_id VARCHAR(255) NOT NULL DEFAULT 'legacy',
    ADD COLUMN operation VARCHAR(255) NOT NULL DEFAULT 'legacy';

ALTER TABLE idempotency_records DROP CONSTRAINT uq_idempotency_org_key;
ALTER TABLE idempotency_records
    ADD CONSTRAINT uq_idempotency_actor_operation_key
    UNIQUE (organization_id, actor_id, operation, idempotency_key);
