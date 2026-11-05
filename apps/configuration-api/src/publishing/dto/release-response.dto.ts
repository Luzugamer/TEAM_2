import { ReleaseManifest } from '../interfaces/release-manifest.interface';

export class ReleaseResponseDto {
  id!: string;
  organization_id!: string;
  event_id!: string;
  release_version!: number;
  effective_at!: string;
  manifest_ref!: string;
  manifest_hash!: string;
  manifest!: ReleaseManifest;
  event_revision_number!: number;
  status!: 'published' | 'superseded' | 'cancelled';
  created_by!: string;
  created_at!: string;
}

