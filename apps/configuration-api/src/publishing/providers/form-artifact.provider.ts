import { Injectable } from '@nestjs/common';
import { PublicationContext } from '../interfaces/publication-context.interface';
import { ArtifactResult } from '../interfaces/artifact-provider.interface';
import { computeSha256 } from '../../shared/crypto/canonical-json';
import { EventStatus } from '../../events/models/event-status.enum';

@Injectable()
export class FormArtifactProvider {
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

  async validateBindings(context: PublicationContext): Promise<{ errors: string[]; warnings: string[] }> {
    return {
      errors: [...this.mockErrors],
      warnings: [...this.mockWarnings],
    };
  }

  async buildFormArtifact(context: PublicationContext): Promise<ArtifactResult> {
    const validation = await this.validateBindings(context);
    const registrationClosed = context.target_status === EventStatus.CLOSED || context.target_status === EventStatus.CANCELLED;

    const body = this.customBody || {
      event_id: context.event_id,
      forms_version: 'v1.0.0-mock',
      bindings: [
        {
          purpose: 'registration',
          form_version_id: '0194eb40-0000-7000-8000-000000000001',
          status: registrationClosed ? 'closed' : 'open',
          opens_at: '2026-11-01T00:00:00Z',
          closes_at: registrationClosed ? context.effective_at : '2026-11-20T12:00:00Z',
          schema: {
            type: 'object',
            required: ['full_name', 'email', 'terms_accepted'],
            properties: {
              full_name: { type: 'string', minLength: 2 },
              email: { type: 'string', format: 'email' },
              terms_accepted: { type: 'boolean', const: true },
            },
          },
          consent: {
            required: true,
            privacy_policy_url: 'https://events.platform/privacy',
            text: 'I agree to the terms and privacy policy of this event.',
          },
        },
      ],
    };

    return {
      kind: 'forms',
      version: 'v1.0.0-mock',
      body,
      hash: computeSha256(body),
      errors: validation.errors,
      warnings: validation.warnings,
    };
  }
}

