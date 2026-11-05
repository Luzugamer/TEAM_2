-- events and event_revisions form a cycle. The new revision is inserted in the
-- same transaction after the event's revision pointer advances.
ALTER TABLE events DROP CONSTRAINT fk_events_current_revision;
ALTER TABLE events ADD CONSTRAINT fk_events_current_revision
    FOREIGN KEY (organization_id, current_revision_id)
    REFERENCES event_revisions (organization_id, id)
    ON DELETE SET NULL
    DEFERRABLE INITIALLY DEFERRED;
