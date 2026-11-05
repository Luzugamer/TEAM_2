import { Injectable } from '@nestjs/common';
import { PublicationContext } from '../interfaces/publication-context.interface';
import { ArtifactResult } from '../interfaces/artifact-provider.interface';
import { computeSha256 } from '../../shared/crypto/canonical-json';

@Injectable()
export class ScheduleArtifactProvider {
  private mockErrors: string[] = [];
  private mockWarnings: string[] = [];
  private customBody: Record<string, unknown> | null = null;

  setMockErrors(errors: string[]) {
    this.mockErrors = errors;
  }

  setMockWarnings(warnings: string[]) {
    this.mockWarnings = warnings;
  }

  setCustomBody(body: Record<string, unknown> | null) {
    this.customBody = body;
  }

  reset() {
    this.mockErrors = [];
    this.mockWarnings = [];
    this.customBody = null;
  }

  async validateSchedule(context: PublicationContext): Promise<{ errors: string[]; warnings: string[] }> {
    return {
      errors: [...this.mockErrors],
      warnings: [...this.mockWarnings],
    };
  }

  async buildScheduleArtifact(context: PublicationContext): Promise<ArtifactResult> {
    const validation = await this.validateSchedule(context);

    const body = this.customBody || {
      event_id: context.event_id,
      schedule_version: 'v1.0.0-mock',
      tracks: [
        { id: '0194eb30-0000-7000-8000-000000000001', title: 'Main Auditorium Track', order: 1 },
      ],
      programs: [
        { id: '0194eb30-0000-7000-8000-000000000002', name: 'Cloud Architecture & DevOps', order: 1 },
      ],
      sessions: [
        {
          id: '0194eb30-0000-7000-8000-000000000003',
          title: 'Opening Keynote: Distributed Systems in the Cloud',
          starts_at: '2026-11-20T14:30:00Z',
          ends_at: '2026-11-20T16:00:00Z',
          venue_id: '0194eb10-0000-7000-8000-000000000001',
          speaker_ids: ['0194eb00-0000-7000-9000-000000000001'],
        },
      ],
    };

    return {
      kind: 'schedule',
      version: 'v1.0.0-mock',
      body,
      hash: computeSha256(body),
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }
}

