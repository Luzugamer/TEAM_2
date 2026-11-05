import { describe, it, expect, beforeEach } from 'vitest';
import { ReleaseAssemblerService } from './release-assembler.service';
import { PublishingRepository } from './publishing.repository';
import { ScheduleArtifactProvider } from './providers/schedule-artifact.provider';
import { FormArtifactProvider } from './providers/form-artifact.provider';
import { EventsService } from '../events/events.service';
import { EventsRepository } from '../events/events.repository';
import { DatabaseService } from '../shared/database/database.service';
import { ConfigService } from '@nestjs/config';
import { TenantClaims } from '../shared/auth/tenant-claims.interface';
import { PublicationContext } from './interfaces/publication-context.interface';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';

describe('ReleaseAssemblerService - EC-030 & EC-031 (Integrante A)', () => {
  let assembler: ReleaseAssemblerService;
  let eventsService: EventsService;
  let eventsRepository: EventsRepository;
  let publishingRepository: PublishingRepository;
  let scheduleProvider: ScheduleArtifactProvider;
  let formProvider: FormArtifactProvider;
  let dbService: DatabaseService;

  const mockClaims: TenantClaims = {
    sub: '0194eb00-0000-7000-9000-000000000001',
    organization_id: '0194eb00-0000-7000-8000-000000000001',
    roles: ['organizer'],
    scopes: ['events:write', 'events:publish'],
  };

  beforeEach(() => {
    dbService = new DatabaseService(new ConfigService());
    eventsRepository = new EventsRepository(dbService);
    eventsService = new EventsService(eventsRepository);
    publishingRepository = new PublishingRepository(dbService, eventsRepository);
    scheduleProvider = new ScheduleArtifactProvider();
    formProvider = new FormArtifactProvider();

    assembler = new ReleaseAssemblerService(
      dbService,
      eventsService,
      publishingRepository,
      scheduleProvider,
      formProvider,
    );
  });

  describe('EC-030: Publication Readiness Checks', () => {
    it('should report is_ready: true when event, dates, schedule, and forms are fully valid', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'ready-event-2026',
          kind: 'conference',
          title: 'Ready Conference 2026',
          timezone: 'America/Lima',
          starts_at: '2026-12-01T10:00:00Z',
          ends_at: '2026-12-03T18:00:00Z',
        },
        'key-ready-1',
      );

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 1,
        effective_at: new Date().toISOString(),
      };

      const readiness = await assembler.validateReadiness(context, mockClaims);

      expect(readiness.is_ready).toBe(true);
      expect(readiness.errors).toHaveLength(0);
      expect(readiness.event_id).toBe(event.id);
      expect(readiness.organization_id).toBe(mockClaims.organization_id);
    });

    it('should report is_ready: false with blocking error if actor lacks events:publish scope', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'unauthorized-publish-event',
          kind: 'conference',
          title: 'Unauthorized Publish',
          timezone: 'UTC',
          starts_at: '2026-12-01T10:00:00Z',
          ends_at: '2026-12-03T18:00:00Z',
        },
        'key-ready-unauth',
      );

      const unprivilegedClaims: TenantClaims = {
        ...mockClaims,
        scopes: ['events:read'], // Missing events:publish
      };

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 1,
        effective_at: new Date().toISOString(),
      };

      const readiness = await assembler.validateReadiness(context, unprivilegedClaims);

      expect(readiness.is_ready).toBe(false);
      expect(readiness.errors.some((e) => e.includes('events:publish'))).toBe(true);
    });

    it('should report is_ready: false if event is in a cancelled or archived state', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'cancelled-event-check',
          kind: 'meetup',
          title: 'Cancelled Check Event',
          timezone: 'UTC',
          starts_at: '2026-12-01T10:00:00Z',
          ends_at: '2026-12-03T18:00:00Z',
        },
        'key-ready-cancel-setup',
      );

      // Cancel event: rev 1 -> 2
      await eventsService.cancelEvent(
        mockClaims,
        event.id,
        1,
        { reason: 'Testing cancellation', effective_at: '2026-11-20T10:00:00Z' },
        'key-cancel-check',
      );

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 2,
        effective_at: new Date().toISOString(),
      };

      const readiness = await assembler.validateReadiness(context, mockClaims);
      expect(readiness.is_ready).toBe(false);
      expect(readiness.errors.some((e) => e.includes('cancelled'))).toBe(true);
    });

    it('should report is_ready: false when schedule provider reports blocking errors', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'bad-schedule-event',
          kind: 'conference',
          title: 'Bad Schedule Event',
          timezone: 'UTC',
          starts_at: '2026-12-01T10:00:00Z',
          ends_at: '2026-12-03T18:00:00Z',
        },
        'key-bad-sched',
      );

      // Simulate Integrante B returning blocking schedule errors
      scheduleProvider.setMockErrors([
        'Track 1 has overlapping session allocations.',
        'Session 3 has no assigned speaker.',
      ]);

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 1,
        effective_at: new Date().toISOString(),
      };

      const readiness = await assembler.validateReadiness(context, mockClaims);
      expect(readiness.is_ready).toBe(false);
      expect(readiness.errors).toContain('Track 1 has overlapping session allocations.');
      expect(readiness.errors).toContain('Session 3 has no assigned speaker.');
    });

    it('should report is_ready: false when form provider reports missing mandatory registration bindings or consent', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'bad-forms-event',
          kind: 'conference',
          title: 'Bad Forms Event',
          timezone: 'UTC',
          starts_at: '2026-12-01T10:00:00Z',
          ends_at: '2026-12-03T18:00:00Z',
        },
        'key-bad-forms',
      );

      // Simulate Integrante C returning missing registration form / consent errors
      formProvider.setMockErrors([
        "Event missing mandatory open registration form binding for purpose 'registration'.",
        'Registration form version requires explicit consent policy configuration.',
      ]);

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 1,
        effective_at: new Date().toISOString(),
      };

      const readiness = await assembler.validateReadiness(context, mockClaims);
      expect(readiness.is_ready).toBe(false);
      expect(readiness.errors).toContain(
        "Event missing mandatory open registration form binding for purpose 'registration'.",
      );
    });

    it('should record non-blocking warnings while preserving is_ready: true', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'warnings-event',
          kind: 'conference',
          title: 'Warnings Event',
          timezone: 'UTC',
          starts_at: '2026-12-01T10:00:00Z',
          ends_at: '2026-12-03T18:00:00Z',
        },
        'key-warn-setup',
      );

      scheduleProvider.setMockWarnings(['Room capacity has not been finalized for Track 2.']);
      formProvider.setMockWarnings(['Optional feedback form binding opens after event ends.']);

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 1,
        effective_at: new Date().toISOString(),
      };

      const readiness = await assembler.validateReadiness(context, mockClaims);
      expect(readiness.is_ready).toBe(true);
      expect(readiness.errors).toHaveLength(0);
      expect(readiness.warnings).toHaveLength(3);
    });
  });

  describe('EC-031: Atomic Release Manifest, RFC 8785 Hashing & Outbox', () => {
    it('should atomically publish release, compute canonical RFC 8785 hashes, and stage domain event in outbox', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'atomic-publish-2026',
          kind: 'conference',
          title: 'Atomic Publish Conference 2026',
          timezone: 'America/Lima',
          starts_at: '2026-12-10T09:00:00Z',
          ends_at: '2026-12-12T19:00:00Z',
        },
        'key-pub-setup-1',
      );

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 1,
        effective_at: '2026-12-01T00:00:00Z',
      };

      const release = await assembler.publishRelease(context, mockClaims, 'idemp-pub-key-1');

      // 1. Verify Release Entity
      expect(release.id).toBeDefined();
      expect(release.organization_id).toBe(mockClaims.organization_id);
      expect(release.event_id).toBe(event.id);
      expect(release.release_version).toBe(1);
      expect(release.event_revision_number).toBe(2);
      expect(release.status).toBe('published');
      expect(release.created_by).toBe(mockClaims.sub);

      // 2. Verify Manifest & RFC 8785 hashes
      expect(release.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(release.manifest.manifest_hash).toBe(release.manifest_hash);
      expect(release.manifest.artifacts.event.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(release.manifest.artifacts.schedule.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(release.manifest.artifacts.forms.sha256).toMatch(/^[a-f0-9]{64}$/);

      // 3. Verify Artifacts Stored
      const artifacts = await assembler.getReleaseArtifacts(mockClaims.organization_id, release.id);
      expect(artifacts).toHaveLength(3);
      expect(artifacts.map((a) => a.kind).sort()).toEqual(['event', 'forms', 'schedule']);

      // 4. Verify Outbox Domain Event
      const outboxMessages = eventsRepository.getOutboxByAggregate(release.id);
      expect(outboxMessages).toHaveLength(1);
      const outbox = outboxMessages[0];
      expect(outbox.event_type).toBe('configuration.event.release_published.v1');
      expect(outbox.aggregate_type).toBe('release');
      expect(outbox.aggregate_id).toBe(release.id);
      expect(outbox.status).toBe('pending');

      const envelope = outbox.payload as any;
      expect(envelope.topic).toBe('configuration.event.release_published.v1');
      expect(envelope.schema_version).toBe(1);
      expect(envelope.aggregate).toEqual({ type: 'release', id: release.id, version: 1 });
      expect(envelope.data.publication_id).toBe(release.id);
      expect(envelope.data.release_version).toBe(1);
      expect(envelope.data.manifest_hash).toBe(release.manifest_hash);

      // 5. Verify Event state advanced
      const updatedEvent = await eventsService.getEventById(mockClaims, event.id);
      expect(updatedEvent.status).toBe('published');
      expect(updatedEvent.revision_number).toBe(2);
    });

    it('should create monotonic incrementing release versions and preserve past releases as immutable', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'multi-release-event',
          kind: 'conference',
          title: 'Multi Release Event',
          timezone: 'America/Lima',
          starts_at: '2026-12-10T09:00:00Z',
          ends_at: '2026-12-12T19:00:00Z',
        },
        'key-multi-rel-setup',
      );

      // First publication: rev 1 -> rev 2, release_version = 1
      const release1 = await assembler.publishRelease(
        {
          organization_id: mockClaims.organization_id,
          event_id: event.id,
          expected_event_revision: 1,
          effective_at: new Date().toISOString(),
        },
        mockClaims,
        'idemp-rel-v1',
      );

      expect(release1.release_version).toBe(1);

      // Second publication: rev 2 -> rev 3, release_version = 2
      const release2 = await assembler.publishRelease(
        {
          organization_id: mockClaims.organization_id,
          event_id: event.id,
          expected_event_revision: 2,
          effective_at: new Date().toISOString(),
        },
        mockClaims,
        'idemp-rel-v2',
      );

      expect(release2.release_version).toBe(2);
      expect(release2.id).not.toBe(release1.id);

      // Both releases exist in history and are immutable
      const history = await assembler.listReleases(mockClaims.organization_id, event.id);
      expect(history).toHaveLength(2);
      expect(history[0].release_version).toBe(2);
      expect(history[1].release_version).toBe(1);
      expect(history[1].manifest_hash).toBe(release1.manifest_hash);
    });

    it('should abort immediately and write no partial records if readiness check fails during publication', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'failing-readiness-pub',
          kind: 'conference',
          title: 'Failing Readiness Pub',
          timezone: 'America/Lima',
          starts_at: '2026-12-10T09:00:00Z',
          ends_at: '2026-12-12T19:00:00Z',
        },
        'key-fail-setup',
      );

      // Inject blocking error into forms provider
      formProvider.setMockErrors(['Missing required participant terms agreement.']);

      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 1,
        effective_at: new Date().toISOString(),
      };

      await expect(
        assembler.publishRelease(context, mockClaims, 'idemp-failed-pub'),
      ).rejects.toThrow(ProblemDetailsException);

      // Verify no releases were created
      const releases = await assembler.listReleases(mockClaims.organization_id, event.id);
      expect(releases).toHaveLength(0);

      // Verify event revision remains unchanged in draft state
      const checkEvent = await eventsService.getEventById(mockClaims, event.id);
      expect(checkEvent.status).toBe('draft');
      expect(checkEvent.revision_number).toBe(1);
    });

    it('should reject publish when expected revision does not match current revision (412 Precondition Failed)', async () => {
      const event = await eventsService.createEvent(
        mockClaims,
        {
          site_id: '0194eb10-0000-7000-8000-000000000001',
          slug: 'stale-rev-publish',
          kind: 'conference',
          title: 'Stale Rev Publish',
          timezone: 'UTC',
          starts_at: '2026-12-10T09:00:00Z',
          ends_at: '2026-12-12T19:00:00Z',
        },
        'key-stale-rev-pub',
      );

      // Current revision is 1, but caller supplies expected 999
      const context: PublicationContext = {
        organization_id: mockClaims.organization_id,
        event_id: event.id,
        expected_event_revision: 999,
        effective_at: new Date().toISOString(),
      };

      await expect(
        assembler.publishRelease(context, mockClaims, 'idemp-stale-key'),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });
});
