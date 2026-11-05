-- Migration: 0002_append_only_history_triggers.sql
-- Description: Enforces strict append-only immutability on event_revisions, releases, and release_artifacts.
-- Author: Integrante A (Eventos y núcleo de publicación) - Equipo 2
-- Specification: EC-041 (Historial append-only de cambios y publicaciones)

-- 1. Trigger function to prevent any UPDATE or DELETE on immutable historical snapshots
CREATE OR REPLACE FUNCTION prevent_immutable_history_modification()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'Table % is strictly append-only and immutable. Modifications (UPDATE) and deletions (DELETE) are prohibited.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- 2. Immutable trigger on event_revisions
DROP TRIGGER IF EXISTS trg_event_revisions_immutable ON event_revisions;
CREATE TRIGGER trg_event_revisions_immutable
    BEFORE UPDATE OR DELETE ON event_revisions
    FOR EACH ROW
    EXECUTE FUNCTION prevent_immutable_history_modification();

-- 3. Immutable trigger on releases
DROP TRIGGER IF EXISTS trg_releases_immutable ON releases;
CREATE TRIGGER trg_releases_immutable
    BEFORE UPDATE OR DELETE ON releases
    FOR EACH ROW
    EXECUTE FUNCTION prevent_immutable_history_modification();

-- 4. Immutable trigger on release_artifacts
DROP TRIGGER IF EXISTS trg_release_artifacts_immutable ON release_artifacts;
CREATE TRIGGER trg_release_artifacts_immutable
    BEFORE UPDATE OR DELETE ON release_artifacts
    FOR EACH ROW
    EXECUTE FUNCTION prevent_immutable_history_modification();

