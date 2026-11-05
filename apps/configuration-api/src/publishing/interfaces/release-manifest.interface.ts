export interface ArtifactReference {
  kind: 'event' | 'schedule' | 'forms';
  version: string;
  ref: string;
  sha256: string;
}

export interface ReleaseManifest {
  validation_mode: 'development_fixture';
  organization_id: string;
  business_event_id: string;
  publication_id: string; // UUIDv7
  release_version: number;
  effective_at: string;
  manifest_ref: string;
  manifest_hash: string; // SHA-256 (RFC 8785)
  artifacts: {
    event: ArtifactReference;
    schedule: ArtifactReference;
    forms: ArtifactReference;
  };
}

