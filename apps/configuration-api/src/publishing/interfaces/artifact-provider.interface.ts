import { PublicationContext } from './publication-context.interface';

export interface ArtifactResult {
  kind: 'event' | 'schedule' | 'forms';
  version: string;
  body: Record<string, unknown>;
  hash: string; // SHA-256 (RFC 8785)
  errors: string[]; // Blocking errors
  warnings: string[]; // Non-blocking operational warnings
}

export interface ArtifactProvider {
  buildArtifact(context: PublicationContext): Promise<ArtifactResult>;
  validate(context: PublicationContext): Promise<{ errors: string[]; warnings: string[] }>;
}

