import { Injectable, Logger } from '@nestjs/common';

export interface MembershipValidationResult {
  isValid: boolean;
  reason?: string;
}

@Injectable()
export class MembershipAdapter {
  private readonly logger = new Logger(MembershipAdapter.name);

  // Local development adapter registry for Sprint 0 multi-tenant testing
  private memberships = new Map<string, { organization_id: string; is_active: boolean }>();

  constructor() {
    // Organization A Users (0194eb00-0000-7000-8000-000000000001)
    this.memberships.set('0194eb00-0000-7000-9000-000000000001', {
      organization_id: '0194eb00-0000-7000-8000-000000000001',
      is_active: true,
    });
    this.memberships.set('0194eb00-0000-7000-9000-000000000002', {
      organization_id: '0194eb00-0000-7000-8000-000000000001',
      is_active: true,
    });
    this.memberships.set('0194eb00-0000-7000-9000-000000000003', {
      organization_id: '0194eb00-0000-7000-8000-000000000001',
      is_active: false, // Suspended / inactive membership
    });

    // Organization B Users (0194eb00-0000-7000-8000-000000000002)
    this.memberships.set('0194eb00-0000-7000-9000-000000000010', {
      organization_id: '0194eb00-0000-7000-8000-000000000002',
      is_active: true,
    });
  }

  /**
   * Registers a membership in the test adapter dynamically during tests.
   */
  registerMembership(userId: string, organizationId: string, isActive: boolean) {
    this.memberships.set(userId, { organization_id: organizationId, is_active: isActive });
  }

  /**
   * Validates that the target user has an active membership within the specified organization.
   */
  async validateActiveMembership(
    organizationId: string,
    userId: string,
  ): Promise<MembershipValidationResult> {
    const member = this.memberships.get(userId);
    if (member) {
      if (member.organization_id !== organizationId) {
        return {
          isValid: false,
          reason: `User '${userId}' does not belong to organization '${organizationId}' (belongs to '${member.organization_id}').`,
        };
      }
      if (!member.is_active) {
        return {
          isValid: false,
          reason: `User '${userId}' has an inactive or suspended membership in organization '${organizationId}'.`,
        };
      }
      return { isValid: true };
    }

    return { isValid: false, reason: `User '${userId}' has no active membership.` };
  }
}

