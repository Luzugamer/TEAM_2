import { ReleaseManifest } from '../interfaces/release-manifest.interface';

export interface ReleaseEntity {
  id: string; // publication_id (UUIDv7)
  organization_id: string;
  event_id: string;
  release_version: number;
  effective_at: string;
  manifest_ref: string;
  manifest_hash: string;
  manifest: ReleaseManifest;
  event_revision_number: number;
  status: 'published' | 'superseded' | 'cancelled';
  created_by: string;
  created_at: string;
}

export interface ReleaseArtifactEntity {
  id: string; // UUIDv7
  organization_id: string;
  release_id: string;
  event_id: string;
  kind: 'event' | 'schedule' | 'forms';
  version: string;
  artifact_ref: string;
  sha256: string;
  body: Record<string, unknown>;
  created_at: string;
}

