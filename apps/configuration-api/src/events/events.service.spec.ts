import { describe, it, expect, beforeEach } from 'vitest';
import { EventsService } from './events.service';
import { EventsRepository } from './events.repository';
import { MembershipAdapter } from './membership.adapter';
import { DatabaseService } from '../shared/database/database.service';
import { ConfigService } from '@nestjs/config';
import { CreateEventDto } from './dto/create-event.dto';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { TenantClaims } from '../shared/auth/tenant-claims.interface';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';

describe('EventsService & Tenant Isolation (Integrante A)', () => {
  let service: EventsService;
  let repository: EventsRepository;
  let membershipAdapter: MembershipAdapter;
  let dbService: DatabaseService;

  const tenantA: TenantClaims = {
    sub: '0194eb00-0000-7000-9000-000000000001',
    organization_id: '0194eb00-0000-7000-8000-000000000001',
    roles: ['organizer'],
    scopes: ['events:write', 'events:publish'],
  };

  const tenantB: TenantClaims = {
    sub: '0194eb00-0000-7000-9000-000000000002',
    organization_id: '0194eb00-0000-7000-8000-000000000002',
    roles: ['organizer'],
    scopes: ['events:write', 'events:publish'],
  };

  const validDto: CreateEventDto = {
    site_id: '0194eb10-0000-7000-8000-000000000001',
    slug: 'cloud-summit-2026',
    kind: 'conference',
    title: 'Cloud Summit 2026',
    description: 'Annual cloud architecture summit',
    timezone: 'America/Lima',
    starts_at: '2026-11-20T14:00:00Z',
    ends_at: '2026-11-22T23:00:00Z',
    policy: { registration: { capacity_limit_type: 'unlimited' } },
  };

  beforeEach(() => {
    dbService = new DatabaseService(new ConfigService());
    repository = new EventsRepository(dbService);
    membershipAdapter = new MembershipAdapter();
    service = new EventsService(repository, membershipAdapter);
  });

  it('should create an event draft with revision 1 and valid snapshot', async () => {
    const created = await service.createEvent(tenantA, validDto, 'test-key-1');

    expect(created.id).toBeDefined();
    expect(created.organization_id).toBe(tenantA.organization_id);
    expect(created.status).toBe('draft');
    expect(created.revision_number).toBe(1);
    expect(created.current_revision_id).toBeDefined();
    expect(created.slug).toBe('cloud-summit-2026');

    // Verify revisions
    const revisions = await service.getRevisions(tenantA, created.id);
    expect(revisions).toHaveLength(1);
    expect(revisions[0].revision_number).toBe(1);
    expect(revisions[0].created_by).toBe(tenantA.sub);
  });

  it('should enforce strict tenant isolation (Tenant B cannot see Tenant A event)', async () => {
    const createdA = await service.createEvent(tenantA, validDto, 'test-key-orgA');

    // Tenant A can see it
    const foundA = await service.getEventById(tenantA, createdA.id);
    expect(foundA.id).toBe(createdA.id);

    // Tenant B cannot see it (throws 404 NOT_FOUND within tenant boundary)
    await expect(service.getEventById(tenantB, createdA.id)).rejects.toThrow(
      ProblemDetailsException,
    );

    // Tenant B list is empty
    const listB = await service.listEvents(tenantB, {});
    expect(listB.items).toHaveLength(0);

    // Tenant A list contains the event
    const listA = await service.listEvents(tenantA, {});
    expect(listA.items).toHaveLength(1);
    expect(listA.items[0].id).toBe(createdA.id);
  });

  it('should reject invalid date range when starts_at >= ends_at', async () => {
    const invalidDatesDto: CreateEventDto = {
      ...validDto,
      starts_at: '2026-11-25T14:00:00Z',
      ends_at: '2026-11-20T14:00:00Z',
    };

    await expect(service.createEvent(tenantA, invalidDatesDto)).rejects.toThrow(
      ProblemDetailsException,
    );
  });

  it('should reject invalid IANA timezone', async () => {
    const invalidTzDto: CreateEventDto = {
      ...validDto,
      timezone: 'Invalid/City_Neverland',
    };

    await expect(service.createEvent(tenantA, invalidTzDto)).rejects.toThrow(
      ProblemDetailsException,
    );
  });

  it('should reject duplicate slug for the same site and tenant', async () => {
    await service.createEvent(tenantA, validDto, 'key-slug-1');

    await expect(service.createEvent(tenantA, validDto, 'key-slug-2')).rejects.toThrow(
      ProblemDetailsException,
    );
  });

  it('should allow identical slug on a different site or tenant', async () => {
    await service.createEvent(tenantA, validDto, 'key-slug-tenantA');

    // Different tenant can use the exact same slug
    const createdB = await service.createEvent(tenantB, validDto, 'key-slug-tenantB');
    expect(createdB.slug).toBe(validDto.slug);
    expect(createdB.organization_id).toBe(tenantB.organization_id);
  });

  it('should assemble snapshot for publication context and verify expected revision', async () => {
    const created = await service.createEvent(tenantA, validDto, 'key-snap');

    const snap = await service.readEventSnapshot(tenantA.organization_id, created.id, 1);
    expect(snap.snapshot.id).toBe(created.id);
    expect(snap.hash).toBeDefined();

    // Fails with 412 if client sends stale revision expectation
    await expect(
      service.readEventSnapshot(tenantA.organization_id, created.id, 999),
    ).rejects.toThrow(ProblemDetailsException);
  });

  describe('EC-002: Optimistic Concurrency & Revision Evolution', () => {
    it('should edit event with matching expected revision, increment revision to 2, and preserve append-only history', async () => {
      const created = await service.createEvent(tenantA, validDto, 'key-ec002-1');
      expect(created.revision_number).toBe(1);

      const updateDto = {
        title: 'Cloud Summit 2026 - Extended Edition',
        description: 'New expanded description',
        change_summary: 'Expanded description and updated title.',
      };

      const updated = await service.updateEvent(tenantA, created.id, 1, updateDto);

      expect(updated.id).toBe(created.id);
      expect(updated.revision_number).toBe(2);
      expect(updated.title).toBe('Cloud Summit 2026 - Extended Edition');
      expect(updated.description).toBe('New expanded description');
      expect(updated.current_revision_id).not.toBe(created.current_revision_id);

      // Verify append-only revisions history
      const revisions = await service.getRevisions(tenantA, created.id);
      expect(revisions).toHaveLength(2);
      // Revisions ordered descending by revision_number
      expect(revisions[0].revision_number).toBe(2);
      expect(revisions[0].snapshot.title).toBe('Cloud Summit 2026 - Extended Edition');
      expect(revisions[1].revision_number).toBe(1);
      expect(revisions[1].snapshot.title).toBe(validDto.title);
    });

    it('should reject stale revision update with 412 Precondition Failed in concurrent editing scenario', async () => {
      const created = await service.createEvent(tenantA, validDto, 'key-concurrent');

      // Actor 1 successfully updates revision 1 -> becomes revision 2
      await service.updateEvent(tenantA, created.id, 1, {
        title: 'Title updated by Actor 1',
      });

      // Actor 2 concurrently tries to update revision 1 (which is now obsolete)
      try {
        await service.updateEvent(tenantA, created.id, 1, {
          title: 'Title updated by Actor 2',
        });
        expect.fail('Expected updateEvent to throw 412 Precondition Failed');
      } catch (err) {
        expect(err).toBeInstanceOf(ProblemDetailsException);
        const pde = err as ProblemDetailsException;
        expect(pde.getStatus()).toBe(412);
        expect(pde.problem.code).toBe('stale_revision');
      }
    });

    it('should reject invalid dates on update if starts_at >= ends_at', async () => {
      const created = await service.createEvent(tenantA, validDto, 'key-dates');

      await expect(
        service.updateEvent(tenantA, created.id, 1, {
          starts_at: '2026-11-23T00:00:00Z',
          ends_at: '2026-11-20T00:00:00Z',
        }),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });

  describe('EC-003: Event Duplication', () => {
    it('should duplicate an event configuration into a new draft with revision 1 and fresh IDs', async () => {
      const source = await service.createEvent(
        tenantA,
        {
          ...validDto,
          policy: { registration: { quota: 100, requires_approval: true } },
          metadata: { custom_tag: 'original-tag' },
        },
        'key-dup-source',
      );

      const duplicateDto = {
        slug: 'cloud-summit-2027',
        site_id: validDto.site_id,
        starts_at: '2027-11-20T14:00:00Z',
        ends_at: '2027-11-22T23:00:00Z',
        title: 'Cloud Summit 2027',
      };

      const duplicated = await service.duplicateEvent(tenantA, source.id, duplicateDto, 'key-dup-1');

      expect(duplicated.id).toBeDefined();
      expect(duplicated.id).not.toBe(source.id);
      expect(duplicated.organization_id).toBe(tenantA.organization_id);
      expect(duplicated.status).toBe('draft');
      expect(duplicated.revision_number).toBe(1);
      expect(duplicated.current_revision_id).not.toBe(source.current_revision_id);
      expect(duplicated.slug).toBe('cloud-summit-2027');
      expect(duplicated.title).toBe('Cloud Summit 2027');
      expect(duplicated.kind).toBe(source.kind);
      expect(duplicated.timezone).toBe(source.timezone);
      expect(duplicated.policy).toEqual(source.policy);
      expect(duplicated.metadata.duplicated_from).toBe(source.id);
      expect(duplicated.metadata.custom_tag).toBe('original-tag');

      // The new duplicated event has its own independent revision history starting at revision 1
      const revisions = await service.getRevisions(tenantA, duplicated.id);
      expect(revisions).toHaveLength(1);
      expect(revisions[0].revision_number).toBe(1);
      expect(revisions[0].snapshot.id).toBe(duplicated.id);
    });

    it('should prevent Tenant B from duplicating an event belonging to Tenant A', async () => {
      const sourceA = await service.createEvent(tenantA, validDto, 'key-dup-isolation');

      const duplicateDto = {
        slug: 'stolen-event',
        site_id: validDto.site_id,
        starts_at: '2027-11-20T14:00:00Z',
        ends_at: '2027-11-22T23:00:00Z',
      };

      await expect(
        service.duplicateEvent(tenantB, sourceA.id, duplicateDto, 'key-dup-attempt'),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should reject duplication if target slug already exists on the same site', async () => {
      const source = await service.createEvent(tenantA, validDto, 'key-dup-slug-test');

      const duplicateDto = {
        slug: validDto.slug, // Re-using existing slug on same site
        site_id: validDto.site_id,
        starts_at: '2027-11-20T14:00:00Z',
        ends_at: '2027-11-22T23:00:00Z',
      };

      await expect(
        service.duplicateEvent(tenantA, source.id, duplicateDto, 'key-dup-conflict'),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });

  describe('EC-004 & EC-005: State Machine Transitions (Close, Cancel, Archive) & Outbox', () => {
    it('should transition draft -> published -> closed (EC-004) updating registration policy', async () => {
      const created = await service.createEvent(tenantA, validDto, 'key-close-setup');
      expect(created.status).toBe('draft');
      expect(created.revision_number).toBe(1);

      // 1. Cannot close an event in draft (must be published first)
      await expect(
        service.closeEvent(tenantA, created.id, 1, { reason: 'Closing prematurely', effective_at: '2026-11-20T10:00:00Z' }),
      ).rejects.toThrow(ProblemDetailsException);

      // 2. Publish event: draft -> published (rev 1 -> 2)
      const published = await service.publishEvent(tenantA, created.id, 1, 'key-publish-step');
      expect(published.status).toBe('published');
      expect(published.revision_number).toBe(2);

      // 3. Close event: published -> closed (rev 2 -> 3)
      const closed = await service.closeEvent(
        tenantA,
        created.id,
        2,
        { reason: 'Cupos agotados. Inscripciones finalizadas.', effective_at: '2026-11-20T10:00:00Z' },
        'key-close-step',
      );
      expect(closed.status).toBe('closed');
      expect(closed.revision_number).toBe(3);
      const regPolicy = closed.policy.registration as Record<string, unknown>;
      expect(regPolicy.status).toBe('closed');
      expect(regPolicy.closure_reason).toBe('Cupos agotados. Inscripciones finalizadas.');
      expect(regPolicy.closed_at).toBeDefined();

      // Stale revision check on close
      await expect(
        service.closeEvent(tenantA, created.id, 1, { reason: 'Stale retry', effective_at: '2026-11-20T10:00:00Z' }),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should cancel event with reason and deposit domain event into outbox (EC-005)', async () => {
      const created = await service.createEvent(tenantA, validDto, 'key-cancel-setup');
      expect(created.status).toBe('draft');

      const cancelled = await service.cancelEvent(
        tenantA,
        created.id,
        1,
        { reason: 'Condiciones meteorológicas adversas.', effective_at: '2026-11-20T10:00:00Z' },
        'key-cancel-step',
      );

      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.cancellation_reason).toBe('Condiciones meteorológicas adversas.');
      expect(cancelled.revision_number).toBe(2);

      // Verify outbox entry
      const outboxMessages = repository.getOutboxByAggregate(created.id);
      expect(outboxMessages).toHaveLength(1);
      const msg = outboxMessages[0];
      expect(msg.event_type).toBe('configuration.event.cancelled.v1');
      expect(msg.status).toBe('pending');
      expect(msg.payload.topic).toBe('configuration.event.cancelled.v1');
      expect(msg.payload.organization_id).toBe(tenantA.organization_id);
      expect(msg.payload.data).toEqual(
        expect.objectContaining({
          event_id: created.id,
          reason_code: 'ORGANIZER_CANCELLED',
          release_id: null,
        }),
      );

      // Cannot re-cancel an already cancelled event
      await expect(
        service.cancelEvent(tenantA, created.id, 2, { reason: 'Double cancel', effective_at: '2026-11-20T10:00:00Z' }),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should strictly allow archive only from terminal states (closed or cancelled) (EC-005)', async () => {
      const created = await service.createEvent(tenantA, validDto, 'key-archive-setup');

      // 1. Cannot archive from draft
      await expect(
        service.archiveEvent(tenantA, created.id, 1, { reason: 'Archive draft attempt' }),
      ).rejects.toThrow(ProblemDetailsException);

      // 2. Publish event (rev 1 -> 2)
      await service.publishEvent(tenantA, created.id, 1);

      // 3. Cannot archive from published
      await expect(
        service.archiveEvent(tenantA, created.id, 2, { reason: 'Archive published attempt' }),
      ).rejects.toThrow(ProblemDetailsException);

      // 4. Cancel event (rev 2 -> 3)
      await service.cancelEvent(tenantA, created.id, 2, { reason: 'Cancelled for testing archive', effective_at: '2026-11-20T10:00:00Z' });

      // 5. Now archive from cancelled (rev 3 -> 4) succeeds
      const archived = await service.archiveEvent(
        tenantA,
        created.id,
        3,
        { reason: 'Archiving cancelled event' },
        'key-archive-step',
      );

      expect(archived.status).toBe('archived');
      expect(archived.revision_number).toBe(4);
    });
  });

  describe('EC-006: Assignments & Authorization Lifecycle', () => {
    const validAssignmentDto: CreateAssignmentDto = {
      user_id: '0194eb00-0000-7000-9000-000000000002', // Active member of Tenant A
      role: 'event-coordinator',
      scopes: ['events:write', 'events:publish'],
      valid_from: '2026-11-20T00:00:00Z',
      valid_to: '2026-11-25T00:00:00Z',
    };

    it('should assign a responsible user with valid membership and active scopes (EC-006)', async () => {
      const event = await service.createEvent(tenantA, validDto, 'key-event-assign-1');

      const assignment = await service.createAssignment(
        tenantA,
        event.id,
        validAssignmentDto,
        'key-assignment-1',
      );

      expect(assignment.id).toBeDefined();
      expect(assignment.organization_id).toBe(tenantA.organization_id);
      expect(assignment.event_id).toBe(event.id);
      expect(assignment.user_id).toBe(validAssignmentDto.user_id);
      expect(assignment.role).toBe('event-coordinator');
      expect(assignment.scopes).toEqual(['events:write', 'events:publish']);
      expect(assignment.is_active).toBe(true);
      expect(assignment.created_by).toBe(tenantA.sub);
    });

    it('should reject assignment when valid_from >= valid_to', async () => {
      const event = await service.createEvent(tenantA, validDto, 'key-event-assign-2');

      const invalidDatesDto: CreateAssignmentDto = {
        ...validAssignmentDto,
        valid_from: '2026-11-25T00:00:00Z',
        valid_to: '2026-11-20T00:00:00Z',
      };

      await expect(
        service.createAssignment(tenantA, event.id, invalidDatesDto),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should reject assignment when user belongs to another organization (multi-tenant boundary)', async () => {
      const event = await service.createEvent(tenantA, validDto, 'key-event-assign-3');

      // User 10 belongs to tenant B
      const crossTenantUserDto: CreateAssignmentDto = {
        ...validAssignmentDto,
        user_id: '0194eb00-0000-7000-9000-000000000010',
      };

      await expect(
        service.createAssignment(tenantA, event.id, crossTenantUserDto),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should reject assignment when user membership is inactive / suspended', async () => {
      const event = await service.createEvent(tenantA, validDto, 'key-event-assign-4');

      // User 3 belongs to Tenant A but has is_active = false
      const inactiveUserDto: CreateAssignmentDto = {
        ...validAssignmentDto,
        user_id: '0194eb00-0000-7000-9000-000000000003',
      };

      await expect(
        service.createAssignment(tenantA, event.id, inactiveUserDto),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should list all assignments associated with an event', async () => {
      const event = await service.createEvent(tenantA, validDto, 'key-event-assign-5');

      await service.createAssignment(
        tenantA,
        event.id,
        {
          ...validAssignmentDto,
          role: 'role-1',
        },
        'key-assign-list-1',
      );

      await service.createAssignment(
        tenantA,
        event.id,
        {
          ...validAssignmentDto,
          role: 'role-2',
        },
        'key-assign-list-2',
      );

      const list = await service.listAssignments(tenantA, event.id);
      expect(list).toHaveLength(2);
      expect(list.map((a) => a.role)).toContain('role-1');
      expect(list.map((a) => a.role)).toContain('role-2');
    });

    it('should verify authorization check passes within validity window and fails outside or after revocation', async () => {
      const event = await service.createEvent(tenantA, validDto, 'key-event-assign-6');

      const assignment = await service.createAssignment(
        tenantA,
        event.id,
        {
          user_id: '0194eb00-0000-7000-9000-000000000002',
          role: 'speaker-lead',
          scopes: ['events:write'],
          valid_from: '2026-11-20T00:00:00Z',
          valid_to: '2026-11-25T00:00:00Z',
        },
        'key-assign-auth-check',
      );

      // Check access during active window
      const hasAccessDuring = await service.checkUserEventAccess(
        tenantA.organization_id,
        event.id,
        '0194eb00-0000-7000-9000-000000000002',
        'events:write',
        new Date('2026-11-22T12:00:00Z'),
      );
      expect(hasAccessDuring).toBe(true);

      // Check access for ungranted scope
      const hasMissingScope = await service.checkUserEventAccess(
        tenantA.organization_id,
        event.id,
        '0194eb00-0000-7000-9000-000000000002',
        'events:publish',
        new Date('2026-11-22T12:00:00Z'),
      );
      expect(hasMissingScope).toBe(false);

      // Check access after expiration
      const hasAccessExpired = await service.checkUserEventAccess(
        tenantA.organization_id,
        event.id,
        '0194eb00-0000-7000-9000-000000000002',
        'events:write',
        new Date('2026-11-26T00:00:00Z'),
      );
      expect(hasAccessExpired).toBe(false);

      // Revoke assignment
      const revoked = await service.revokeAssignment(
        tenantA,
        event.id,
        assignment.id,
        'key-revoke-check',
      );
      expect(revoked.is_active).toBe(false);

      // Now access during valid window should also return false
      const hasAccessAfterRevoke = await service.checkUserEventAccess(
        tenantA.organization_id,
        event.id,
        '0194eb00-0000-7000-9000-000000000002',
        'events:write',
        new Date('2026-11-22T12:00:00Z'),
      );
      expect(hasAccessAfterRevoke).toBe(false);
    });

    it('should reject revoking an assignment that does not belong to the target event', async () => {
      const event1 = await service.createEvent(tenantA, validDto, 'key-event-rev-1');
      const event2 = await service.createEvent(
        tenantA,
        { ...validDto, slug: 'another-event-slug' },
        'key-event-rev-2',
      );

      const assignment1 = await service.createAssignment(
        tenantA,
        event1.id,
        validAssignmentDto,
        'key-assign-ev1',
      );

      // Attempt to revoke assignment1 via event2
      await expect(
        service.revokeAssignment(tenantA, event2.id, assignment1.id),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });

  describe('EC-041: Append-Only Audit Trail & History Lifecycle', () => {
    it('should accurately capture actor, revision, diff, hash and request ID across all mutations', async () => {
      const tenantWithReq: TenantClaims = {
        ...tenantA,
        request_id: '0194eb50-0000-7000-8000-000000000001',
      };

      // 1. Create event
      const event = await service.createEvent(tenantWithReq, validDto, 'audit-create-key');
      expect(event.revision_number).toBe(1);

      // 2. Update event (revision 1 -> 2)
      await service.updateEvent(
        tenantWithReq,
        event.id,
        1,
        {
          title: 'Cloud Summit 2026 - Updated Title',
          change_summary: 'Title refined for branding',
        },
      );

      // 3. Assign role
      const assign = await service.createAssignment(
        tenantWithReq,
        event.id,
        {
          user_id: '0194eb00-0000-7000-9000-000000000002',
          role: 'track-lead',
          scopes: ['events:write'],
        },
        'audit-assign-key',
      );

      // 4. Revoke assignment
      await service.revokeAssignment(tenantWithReq, event.id, assign.id, 'audit-revoke-key');

      // 5. Query Audit Trail
      const auditTrail = await service.getAuditTrail(tenantWithReq, event.id);
      expect(auditTrail.length).toBeGreaterThanOrEqual(4);

      // Verify all entries contain actor, request_id, diff, created_at, organization_id
      for (const entry of auditTrail) {
        expect(entry.organization_id).toBe(tenantA.organization_id);
        expect(entry.actor_id).toBe(tenantWithReq.sub);
        expect(entry.request_id).toBe(tenantWithReq.request_id);
        expect(entry.created_at).toBeDefined();
        expect(entry.diff).toBeDefined();
      }

      // Actions should include REVOKE_ROLE, ASSIGN_ROLE, UPDATE, CREATE
      const actions = auditTrail.map((a) => a.action);
      expect(actions).toContain('CREATE');
      expect(actions).toContain('UPDATE');
      expect(actions).toContain('ASSIGN_ROLE');
      expect(actions).toContain('REVOKE_ROLE');

      // 6. Query Complete History
      const history = await service.getEventHistory(tenantWithReq, event.id);
      expect(history.event_id).toBe(event.id);
      expect(history.current_revision).toBe(2);
      expect(history.revisions).toHaveLength(2);
      expect(history.revisions[0].revision_number).toBe(2);
      expect(history.revisions[1].revision_number).toBe(1);
      expect(history.audit_trail).toEqual(auditTrail);
    });

    it('should strictly isolate audit trail by tenant (Tenant B cannot read Tenant A audit)', async () => {
      const eventA = await service.createEvent(tenantA, validDto, 'audit-tenant-iso-key');

      // Tenant B queries Tenant A event audit -> throws 404 Not Found
      await expect(
        service.getAuditTrail(tenantB, eventA.id),
      ).rejects.toThrow(ProblemDetailsException);

      await expect(
        service.getEventHistory(tenantB, eventA.id),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should throw 404 ProblemDetailsException when event does not exist', async () => {
      const nonExistentId = '0194eb00-9999-7000-8000-000000000000';
      await expect(
        service.getAuditTrail(tenantA, nonExistentId),
      ).rejects.toThrow(ProblemDetailsException);

      await expect(
        service.getEventHistory(tenantA, nonExistentId),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });
});

