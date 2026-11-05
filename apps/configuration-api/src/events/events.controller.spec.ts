import { describe, it, expect, beforeEach } from 'vitest';
import { EventsController } from './events.controller';
import { EventsService } from './events.service';
import { EventsRepository } from './events.repository';
import { ReleaseAssemblerService } from '../publishing/release-assembler.service';
import { PublishingRepository } from '../publishing/publishing.repository';
import { ScheduleArtifactProvider } from '../publishing/providers/schedule-artifact.provider';
import { FormArtifactProvider } from '../publishing/providers/form-artifact.provider';
import { DatabaseService } from '../shared/database/database.service';
import { IdempotencyService } from '../shared/idempotency/idempotency.service';
import { ConfigService } from '@nestjs/config';
import { CreateEventDto } from './dto/create-event.dto';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { CreateReleaseDto } from '../publishing/dto/create-release.dto';
import { TenantClaims } from '../shared/auth/tenant-claims.interface';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';
import { Request, Response } from 'express';

describe('EventsController & Idempotency / ETag Rules', () => {
  let controller: EventsController;
  let service: EventsService;
  let repository: EventsRepository;
  let idempotencyService: IdempotencyService;
  let releaseAssembler: ReleaseAssemblerService;
  let publishingRepository: PublishingRepository;
  let scheduleProvider: ScheduleArtifactProvider;
  let formProvider: FormArtifactProvider;

  const mockClaims: TenantClaims = {
    sub: '0194eb00-0000-7000-9000-000000000001',
    organization_id: '0194eb00-0000-7000-8000-000000000001',
    roles: ['organizer'],
    scopes: ['events:write', 'events:publish'],
  };

  const validDto: CreateEventDto = {
    site_id: '0194eb10-0000-7000-8000-000000000001',
    slug: 'tech-summit-2026',
    kind: 'conference',
    title: 'Tech Summit 2026',
    description: 'Premier Tech Conference',
    timezone: 'America/Lima',
    starts_at: '2026-11-20T10:00:00Z',
    ends_at: '2026-11-22T20:00:00Z',
    policy: { capacity: 500 },
  };

  const createMockResponse = () => {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let responseBody: unknown = null;

    const res: Partial<Response> = {
      setHeader: (name: string, value: string) => {
        headers[name] = value;
        return res as Response;
      },
      status: (code: number) => {
        statusCode = code;
        return res as Response;
      },
      json: (body: unknown) => {
        responseBody = body;
        return res as Response;
      },
    };

    return {
      res: res as Response,
      getHeaders: () => headers,
      getStatusCode: () => statusCode,
      getBody: () => responseBody,
    };
  };

  beforeEach(() => {
    const dbService = new DatabaseService(new ConfigService());
    repository = new EventsRepository(dbService);
    service = new EventsService(repository);
    idempotencyService = new IdempotencyService(dbService);
    publishingRepository = new PublishingRepository(dbService, repository);
    scheduleProvider = new ScheduleArtifactProvider();
    formProvider = new FormArtifactProvider();
    releaseAssembler = new ReleaseAssemblerService(
      dbService,
      service,
      publishingRepository,
      scheduleProvider,
      formProvider,
    );
    controller = new EventsController(service, idempotencyService, releaseAssembler);
  });

  it('should throw 400 Bad Request when Idempotency-Key header is missing on POST /events', async () => {
    const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
    const { res } = createMockResponse();

    await expect(
      controller.createEvent(mockClaims, validDto, undefined, mockReq, res),
    ).rejects.toThrow(ProblemDetailsException);
  });

  it('should create event, return 201 Created and set ETag header on first attempt', async () => {
    const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
    const mockRes = createMockResponse();

    await controller.createEvent(mockClaims, validDto, 'idemp-key-1', mockReq, mockRes.res);

    expect(mockRes.getStatusCode()).toBe(201);
    expect(mockRes.getHeaders()['ETag']).toBe('"1"');
    const body = mockRes.getBody() as any;
    expect(body.id).toBeDefined();
    expect(body.slug).toBe('tech-summit-2026');
    expect(body.revision_number).toBe(1);
  });

  it('should return identical cached response on duplicate request with same Idempotency-Key and payload', async () => {
    const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
    const firstCall = createMockResponse();
    const secondCall = createMockResponse();

    // First attempt
    await controller.createEvent(mockClaims, validDto, 'idemp-key-replay', mockReq, firstCall.res);
    expect(firstCall.getStatusCode()).toBe(201);
    const firstBody = firstCall.getBody() as any;

    // Second attempt (replay)
    await controller.createEvent(mockClaims, validDto, 'idemp-key-replay', mockReq, secondCall.res);
    expect(secondCall.getStatusCode()).toBe(201);
    const secondBody = secondCall.getBody() as any;

    expect(secondBody.id).toBe(firstBody.id);
    expect(secondCall.getHeaders()['ETag']).toBe('"1"');
  });

  it('should throw 409 Conflict when same Idempotency-Key is used with different payload', async () => {
    const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
    const firstCall = createMockResponse();
    const secondCall = createMockResponse();

    // First attempt
    await controller.createEvent(mockClaims, validDto, 'idemp-key-conflict', mockReq, firstCall.res);

    // Second attempt with modified payload
    const modifiedDto = { ...validDto, title: 'Completely Different Title' };
    await expect(
      controller.createEvent(mockClaims, modifiedDto, 'idemp-key-conflict', mockReq, secondCall.res),
    ).rejects.toThrow(ProblemDetailsException);
  });

  it('should list events for authenticated tenant', async () => {
    const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
    const { res } = createMockResponse();
    await controller.createEvent(mockClaims, validDto, 'key-list-1', mockReq, res);

    const listResult = await controller.listEvents(mockClaims, {});
    expect(listResult.items).toHaveLength(1);
    expect(listResult.items[0].slug).toBe('tech-summit-2026');
    expect(listResult.page_info).toBeDefined();
  });

  it('should fetch event by ID and set ETag with current revision number', async () => {
    const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
    const createRes = createMockResponse();
    await controller.createEvent(mockClaims, validDto, 'key-get-1', mockReq, createRes.res);
    const createdEvent = createRes.getBody() as any;

    const getRes = createMockResponse();
    await controller.getEventById(mockClaims, createdEvent.id, getRes.res);

    expect(getRes.getStatusCode()).toBe(200);
    expect(getRes.getHeaders()['ETag']).toBe('"1"');
    expect((getRes.getBody() as any).id).toBe(createdEvent.id);
  });

  describe('EC-002 Controller: If-Match & Optimistic Concurrency', () => {
    it('should reject PATCH /events/:id with 428 Precondition Required when If-Match header is missing', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-patch-setup-1', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const patchRes = createMockResponse();
      try {
        await controller.updateEvent(mockClaims, created.id, undefined, { title: 'Updated' }, patchRes.res);
        expect.fail('Expected updateEvent to throw 428');
      } catch (err) {
        expect(err).toBeInstanceOf(ProblemDetailsException);
        const pde = err as ProblemDetailsException;
        expect(pde.getStatus()).toBe(428);
        expect(pde.problem.code).toBe('precondition_required');
      }
    });

    it('should reject PATCH /events/:id with 400 Bad Request when If-Match header is malformed', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-patch-setup-2', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const patchRes = createMockResponse();
      try {
        await controller.updateEvent(mockClaims, created.id, 'not-a-number', { title: 'Updated' }, patchRes.res);
        expect.fail('Expected updateEvent to throw 400');
      } catch (err) {
        expect(err).toBeInstanceOf(ProblemDetailsException);
        const pde = err as ProblemDetailsException;
        expect(pde.getStatus()).toBe(400);
      }
    });

    it('should update event with valid If-Match header, increment revision, and return new ETag: "2"', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-patch-setup-3', mockReq, createRes.res);
      const created = createRes.getBody() as any;
      expect(created.revision_number).toBe(1);

      const patchRes = createMockResponse();
      await controller.updateEvent(
        mockClaims,
        created.id,
        '"1"',
        { title: 'Tech Summit 2026 (Updated Title)', change_summary: 'Title refined' },
        patchRes.res,
      );

      expect(patchRes.getStatusCode()).toBe(200);
      expect(patchRes.getHeaders()['ETag']).toBe('"2"');
      const updatedBody = patchRes.getBody() as any;
      expect(updatedBody.revision_number).toBe(2);
      expect(updatedBody.title).toBe('Tech Summit 2026 (Updated Title)');
    });

    it('should reject with 412 Precondition Failed when If-Match is stale after a prior update', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-patch-setup-4', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      // First update moves revision 1 -> 2
      const firstPatchRes = createMockResponse();
      await controller.updateEvent(
        mockClaims,
        created.id,
        '"1"',
        { title: 'First Update' },
        firstPatchRes.res,
      );
      expect(firstPatchRes.getStatusCode()).toBe(200);
      expect(firstPatchRes.getHeaders()['ETag']).toBe('"2"');

      // Second update still uses stale revision "1"
      const stalePatchRes = createMockResponse();
      try {
        await controller.updateEvent(
          mockClaims,
          created.id,
          '"1"',
          { title: 'Second Update with Stale Revision' },
          stalePatchRes.res,
        );
        expect.fail('Expected updateEvent to throw 412 Precondition Failed');
      } catch (err) {
        expect(err).toBeInstanceOf(ProblemDetailsException);
        const pde = err as ProblemDetailsException;
        expect(pde.getStatus()).toBe(412);
        expect(pde.problem.code).toBe('stale_revision');
      }
    });
  });

  describe('EC-003 Controller: Event Duplication', () => {
    it('should reject POST /events/:id/duplications with 400 when Idempotency-Key is missing', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events/some-id/duplications' } as Request;
      const { res } = createMockResponse();

      await expect(
        controller.duplicateEvent(
          mockClaims,
          'some-id',
          { slug: 'new-slug', site_id: validDto.site_id, starts_at: '2027-01-01T00:00:00Z', ends_at: '2027-01-02T00:00:00Z' },
          undefined,
          mockReq,
          res,
        ),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should duplicate event, return 201 Created and set ETag: "1" on first attempt', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-dup-controller-setup', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const dupReq = { originalUrl: `/configuration/v1/events/${created.id}/duplications` } as Request;
      const dupRes = createMockResponse();
      const duplicateDto = {
        slug: 'tech-summit-duplicated',
        site_id: validDto.site_id,
        starts_at: '2027-11-20T10:00:00Z',
        ends_at: '2027-11-22T20:00:00Z',
      };

      await controller.duplicateEvent(mockClaims, created.id, duplicateDto, 'idemp-dup-1', dupReq, dupRes.res);

      expect(dupRes.getStatusCode()).toBe(201);
      expect(dupRes.getHeaders()['ETag']).toBe('"1"');
      const duplicatedBody = dupRes.getBody() as any;
      expect(duplicatedBody.id).toBeDefined();
      expect(duplicatedBody.id).not.toBe(created.id);
      expect(duplicatedBody.slug).toBe('tech-summit-duplicated');
      expect(duplicatedBody.status).toBe('draft');
      expect(duplicatedBody.revision_number).toBe(1);
    });

    it('should return identical response when repeating duplication request with same Idempotency-Key and payload', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-dup-idemp-setup', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const dupReq = { originalUrl: `/configuration/v1/events/${created.id}/duplications` } as Request;
      const firstDupRes = createMockResponse();
      const secondDupRes = createMockResponse();
      const duplicateDto = {
        slug: 'tech-summit-replay',
        site_id: validDto.site_id,
        starts_at: '2027-11-20T10:00:00Z',
        ends_at: '2027-11-22T20:00:00Z',
      };

      // First call
      await controller.duplicateEvent(mockClaims, created.id, duplicateDto, 'idemp-dup-replay', dupReq, firstDupRes.res);
      expect(firstDupRes.getStatusCode()).toBe(201);
      const firstBody = firstDupRes.getBody() as any;

      // Second call (replay)
      await controller.duplicateEvent(mockClaims, created.id, duplicateDto, 'idemp-dup-replay', dupReq, secondDupRes.res);
      expect(secondDupRes.getStatusCode()).toBe(201);
      const secondBody = secondDupRes.getBody() as any;

      expect(secondBody.id).toBe(firstBody.id);
      expect(secondDupRes.getHeaders()['ETag']).toBe('"1"');
    });

    it('should throw 409 Conflict when same Idempotency-Key is used on duplicate with modified payload', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-dup-conflict-setup', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const dupReq = { originalUrl: `/configuration/v1/events/${created.id}/duplications` } as Request;
      const firstDupRes = createMockResponse();
      const secondDupRes = createMockResponse();

      const initialDto = {
        slug: 'tech-summit-conflict-1',
        site_id: validDto.site_id,
        starts_at: '2027-11-20T10:00:00Z',
        ends_at: '2027-11-22T20:00:00Z',
      };

      await controller.duplicateEvent(mockClaims, created.id, initialDto, 'idemp-dup-conflict-key', dupReq, firstDupRes.res);

      const modifiedDto = {
        ...initialDto,
        slug: 'tech-summit-conflict-2',
      };

      await expect(
        controller.duplicateEvent(mockClaims, created.id, modifiedDto, 'idemp-dup-conflict-key', dupReq, secondDupRes.res),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });

  describe('EC-004 & EC-005 Controller: State Transitions (Close, Cancel, Archive)', () => {
    it('should cancel an event with reason, advance revision, set ETag, and require If-Match/Idempotency-Key', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-cancel-ctrl-setup', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      // 1. Missing If-Match -> 428
      const cancelReq = { originalUrl: `/configuration/v1/events/${created.id}/cancellations` } as Request;
      const cancelRes1 = createMockResponse();
      await expect(
        controller.cancelEvent(
          mockClaims,
          created.id,
          undefined,
          'idemp-cancel-1',
          { reason: 'Test reason', effective_at: '2026-11-20T10:00:00Z' },
          cancelReq,
          cancelRes1.res,
        ),
      ).rejects.toThrow(ProblemDetailsException);

      // 2. Missing Idempotency-Key -> 400
      const cancelRes2 = createMockResponse();
      await expect(
        controller.cancelEvent(
          mockClaims,
          created.id,
          '"1"',
          undefined,
          { reason: 'Test reason', effective_at: '2026-11-20T10:00:00Z' },
          cancelReq,
          cancelRes2.res,
        ),
      ).rejects.toThrow(ProblemDetailsException);

      // 3. Valid cancel -> 200 OK, ETag: "2"
      const cancelRes3 = createMockResponse();
      await controller.cancelEvent(
        mockClaims,
        created.id,
        '"1"',
        'idemp-cancel-valid',
        { reason: 'Fuerza mayor', effective_at: '2026-11-20T10:00:00Z' },
        cancelReq,
        cancelRes3.res,
      );

      expect(cancelRes3.getStatusCode()).toBe(200);
      expect(cancelRes3.getHeaders()['ETag']).toBe('"2"');
      const cancelledBody = cancelRes3.getBody() as any;
      expect(cancelledBody.status).toBe('cancelled');
      expect(cancelledBody.cancellation_reason).toBe('Fuerza mayor');
      expect(cancelledBody.revision_number).toBe(2);
    });

    it('should close a published event (EC-004) and return new ETag', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-close-ctrl-setup', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      // Publish event first (rev 1 -> 2)
      const pubReq = { originalUrl: `/configuration/v1/events/${created.id}/releases` } as Request;
      const pubRes = createMockResponse();
      await controller.createRelease(mockClaims, created.id, '"1"', 'idemp-pub-ctrl', { expected_event_revision: 1 }, pubReq, pubRes.res);
      expect(pubRes.getStatusCode()).toBe(201);
      expect(pubRes.getHeaders()['ETag']).toBe('"2"');

      // Close event (rev 2 -> 3)
      const closeReq = { originalUrl: `/configuration/v1/events/${created.id}/closures` } as Request;
      const closeRes = createMockResponse();
      await controller.closeEvent(
        mockClaims,
        created.id,
        '"2"',
        'idemp-close-ctrl',
        { reason: 'Inscripciones cerradas', effective_at: '2026-11-20T10:00:00Z' },
        closeReq,
        closeRes.res,
      );

      expect(closeRes.getStatusCode()).toBe(200);
      expect(closeRes.getHeaders()['ETag']).toBe('"4"');
      const closedBody = closeRes.getBody() as any;
      expect(closedBody.status).toBe('closed');
      expect(closedBody.revision_number).toBe(4);
    });

    it('should archive a closed event (EC-005) and reject jump from draft', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'key-archive-ctrl-setup', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const archiveReq = { originalUrl: `/configuration/v1/events/${created.id}/archives` } as Request;
      const archiveRes1 = createMockResponse();

      // Jump from draft to archived is forbidden -> 422
      await expect(
        controller.archiveEvent(
          mockClaims,
          created.id,
          '"1"',
          'idemp-arch-invalid',
          archiveReq,
          archiveRes1.res,
        ),
      ).rejects.toThrow(ProblemDetailsException);

      // Cancel first: draft -> cancelled (rev 1 -> 2)
      const cancelReq = { originalUrl: `/configuration/v1/events/${created.id}/cancellations` } as Request;
      const cancelRes = createMockResponse();
      await controller.cancelEvent(
        mockClaims,
        created.id,
        '"1"',
        'idemp-cancel-for-arch',
        { reason: 'Cancel prior to archive', effective_at: '2026-11-20T10:00:00Z' },
        cancelReq,
        cancelRes.res,
      );

      // Now archive: cancelled -> archived (rev 2 -> 3)
      const archiveRes2 = createMockResponse();
      await controller.archiveEvent(
        mockClaims,
        created.id,
        '"2"',
        'idemp-arch-valid',
        archiveReq,
        archiveRes2.res,
      );

      expect(archiveRes2.getStatusCode()).toBe(200);
      expect(archiveRes2.getHeaders()['ETag']).toBe('"3"');
      const archivedBody = archiveRes2.getBody() as any;
      expect(archivedBody.status).toBe('archived');
      expect(archivedBody.revision_number).toBe(3);
    });
  });

  describe('EC-006: Assignments Controller Endpoints', () => {
    const validAssignmentDto: CreateAssignmentDto = {
      user_id: '0194eb00-0000-7000-9000-000000000002',
      role: 'stage-manager',
      scopes: ['events:write'],
      valid_from: '2026-11-20T08:00:00Z',
      valid_to: '2026-11-22T22:00:00Z',
    };

    it('should throw 400 Bad Request when Idempotency-Key header is missing on POST /events/:id/assignments', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-assign-setup-1', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const assignReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments` } as Request;
      const assignRes = createMockResponse();

      await expect(
        controller.createAssignment(mockClaims, created.id, undefined, validAssignmentDto, assignReq, assignRes.res),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should create assignment on POST /events/:id/assignments and return 201 Created', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-assign-setup-2', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const assignReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments` } as Request;
      const assignRes = createMockResponse();

      await controller.createAssignment(
        mockClaims,
        created.id,
        'idemp-assign-key-1',
        validAssignmentDto,
        assignReq,
        assignRes.res,
      );

      expect(assignRes.getStatusCode()).toBe(201);
      const body = assignRes.getBody() as any;
      expect(body.id).toBeDefined();
      expect(body.user_id).toBe(validAssignmentDto.user_id);
      expect(body.role).toBe('stage-manager');
      expect(body.is_active).toBe(true);
    });

    it('should return cached response on duplicate idempotent POST /events/:id/assignments', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-assign-setup-3', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const assignReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments` } as Request;
      const assignRes1 = createMockResponse();
      await controller.createAssignment(
        mockClaims,
        created.id,
        'idemp-assign-key-cached',
        validAssignmentDto,
        assignReq,
        assignRes1.res,
      );

      const assignRes2 = createMockResponse();
      await controller.createAssignment(
        mockClaims,
        created.id,
        'idemp-assign-key-cached',
        validAssignmentDto,
        assignReq,
        assignRes2.res,
      );

      expect(assignRes2.getStatusCode()).toBe(201);
      expect((assignRes2.getBody() as any).id).toBe((assignRes1.getBody() as any).id);
    });

    it('should list assignments on GET /events/:id/assignments', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-assign-setup-4', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const assignReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments` } as Request;
      const assignRes = createMockResponse();
      await controller.createAssignment(
        mockClaims,
        created.id,
        'idemp-assign-list-key',
        validAssignmentDto,
        assignReq,
        assignRes.res,
      );

      const list = await controller.listAssignments(mockClaims, created.id);
      expect(Array.isArray(list)).toBe(true);
      expect(list.length).toBeGreaterThanOrEqual(1);
      expect(list[0].role).toBe('stage-manager');
    });

    it('should throw 400 Bad Request when Idempotency-Key header is missing on DELETE /events/:id/assignments/:assignment_id', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-assign-setup-5', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const assignReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments` } as Request;
      const assignRes = createMockResponse();
      await controller.createAssignment(
        mockClaims,
        created.id,
        'idemp-assign-create-del',
        validAssignmentDto,
        assignReq,
        assignRes.res,
      );
      const assignment = assignRes.getBody() as any;

      const deleteReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments/${assignment.id}` } as Request;
      const deleteRes = createMockResponse();

      await expect(
        controller.revokeAssignment(mockClaims, created.id, assignment.id, undefined, deleteReq, deleteRes.res),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should revoke assignment on DELETE /events/:id/assignments/:assignment_id and return 200 with is_active = false', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-assign-setup-6', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const assignReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments` } as Request;
      const assignRes = createMockResponse();
      await controller.createAssignment(
        mockClaims,
        created.id,
        'idemp-assign-create-del-ok',
        validAssignmentDto,
        assignReq,
        assignRes.res,
      );
      const assignment = assignRes.getBody() as any;

      const deleteReq = { originalUrl: `/configuration/v1/events/${created.id}/assignments/${assignment.id}` } as Request;
      const deleteRes = createMockResponse();

      await controller.revokeAssignment(
        mockClaims,
        created.id,
        assignment.id,
        'idemp-assign-revoke-key',
        deleteReq,
        deleteRes.res,
      );

      expect(deleteRes.getStatusCode()).toBe(200);
      const revoked = deleteRes.getBody() as any;
      expect(revoked.id).toBe(assignment.id);
      expect(revoked.is_active).toBe(false);
    });
  });

  describe('EC-030 & EC-031: Releases & Readiness Controller Endpoints', () => {
    it('should query readiness on POST /events/:id/publication-validations and return 200 OK with report', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-readiness-setup', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const report = await controller.validatePublication(mockClaims, created.id, { expected_event_revision: 1 });
      expect(report.is_ready).toBe(true);
      expect(report.errors).toHaveLength(0);
      expect(report.event_id).toBe(created.id);
    });

    it('should throw 400 Bad Request when Idempotency-Key header is missing on POST /events/:id/releases', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-rel-setup-1', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const releaseReq = { originalUrl: `/configuration/v1/events/${created.id}/releases` } as Request;
      const releaseRes = createMockResponse();

      await expect(
        controller.createRelease(mockClaims, created.id, '"1"', undefined, { expected_event_revision: 1 }, releaseReq, releaseRes.res),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should throw 428 Precondition Required when If-Match header is missing on POST /events/:id/releases', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-rel-setup-2', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const releaseReq = { originalUrl: `/configuration/v1/events/${created.id}/releases` } as Request;
      const releaseRes = createMockResponse();

      await expect(
        controller.createRelease(mockClaims, created.id, undefined, 'idemp-key-missing-ifmatch', { expected_event_revision: 1 }, releaseReq, releaseRes.res),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should throw 412 Precondition Failed when If-Match revision is stale on POST /events/:id/releases', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-rel-setup-3', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const releaseReq = { originalUrl: `/configuration/v1/events/${created.id}/releases` } as Request;
      const releaseRes = createMockResponse();

      await expect(
        controller.createRelease(mockClaims, created.id, '"999"', 'idemp-key-stale-ifmatch', { expected_event_revision: 999 }, releaseReq, releaseRes.res),
      ).rejects.toThrow(ProblemDetailsException);
    });

    it('should publish release on POST /events/:id/releases and return 201 Created with ETag', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-rel-setup-4', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const releaseReq = { originalUrl: `/configuration/v1/events/${created.id}/releases` } as Request;
      const releaseRes = createMockResponse();

      await controller.createRelease(
        mockClaims,
        created.id,
        '"1"',
        'idemp-release-publish-key',
        { expected_event_revision: 1, effective_at: '2026-11-20T10:00:00Z' },
        releaseReq,
        releaseRes.res,
      );

      expect(releaseRes.getStatusCode()).toBe(201);
      expect(releaseRes.getHeaders()['ETag']).toBe('"2"');
      const release = releaseRes.getBody() as any;
      expect(release.id).toBeDefined();
      expect(release.release_version).toBe(1);
      expect(release.manifest_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(release.manifest.artifacts.event.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should return cached response on duplicate idempotent POST /events/:id/releases', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-rel-setup-5', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const releaseReq = { originalUrl: `/configuration/v1/events/${created.id}/releases` } as Request;
      const releaseRes1 = createMockResponse();
      await controller.createRelease(
        mockClaims,
        created.id,
        '"1"',
        'idemp-rel-key-cached',
        { expected_event_revision: 1, effective_at: '2026-11-20T10:00:00Z' },
        releaseReq,
        releaseRes1.res,
      );

      const releaseRes2 = createMockResponse();
      await controller.createRelease(
        mockClaims,
        created.id,
        '"1"',
        'idemp-rel-key-cached',
        { expected_event_revision: 1, effective_at: '2026-11-20T10:00:00Z' },
        releaseReq,
        releaseRes2.res,
      );

      expect(releaseRes2.getStatusCode()).toBe(201);
      expect((releaseRes2.getBody() as any).id).toBe((releaseRes1.getBody() as any).id);
    });

    it('should list releases on GET /events/:id/releases and get release by ID', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-rel-setup-6', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const releaseReq = { originalUrl: `/configuration/v1/events/${created.id}/releases` } as Request;
      const releaseRes = createMockResponse();
      await controller.createRelease(
        mockClaims,
        created.id,
        '"1"',
        'idemp-rel-list-key',
        { expected_event_revision: 1 },
        releaseReq,
        releaseRes.res,
      );
      const publishedRelease = releaseRes.getBody() as any;

      // 1. List releases
      const releases = await controller.listReleases(mockClaims, created.id);
      expect(releases).toHaveLength(1);
      expect(releases[0].id).toBe(publishedRelease.id);

      // 2. Get single release by ID
      const single = await controller.getReleaseById(mockClaims, created.id, publishedRelease.id);
      expect(single.id).toBe(publishedRelease.id);
      expect(single.manifest_hash).toBe(publishedRelease.manifest_hash);
    });
  });

  describe('EC-041: Audit & History Controller Endpoints', () => {
    it('should return 200 OK with audit trail on GET /events/:id/audit', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-audit-ctrl-1', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      const auditTrail = await controller.getAuditTrail(mockClaims, created.id);
      expect(Array.isArray(auditTrail)).toBe(true);
      expect(auditTrail.length).toBeGreaterThanOrEqual(1);
      expect(auditTrail[0].organization_id).toBe(mockClaims.organization_id);
      expect(auditTrail[0].action).toBe('CREATE');
      expect(auditTrail[0].actor_id).toBe(mockClaims.sub);
    });

    it('should return 200 OK with complete history on GET /events/:id/history', async () => {
      const mockReq = { originalUrl: '/configuration/v1/events' } as Request;
      const createRes = createMockResponse();
      await controller.createEvent(mockClaims, validDto, 'idemp-hist-ctrl-1', mockReq, createRes.res);
      const created = createRes.getBody() as any;

      // Update event
      const updateRes = createMockResponse();
      await controller.updateEvent(
        mockClaims,
        created.id,
        '"1"',
        { title: 'New History Title' },
        updateRes.res,
      );

      const history = await controller.getEventHistory(mockClaims, created.id);
      expect(history.event_id).toBe(created.id);
      expect(history.current_revision).toBe(2);
      expect(history.revisions).toHaveLength(2);
      expect(history.audit_trail.length).toBeGreaterThanOrEqual(2);
    });

    it('should throw 404 ProblemDetailsException when querying audit for a non-existent event', async () => {
      const nonExistentId = '0194eb00-9999-7000-8000-000000000000';
      await expect(
        controller.getAuditTrail(mockClaims, nonExistentId),
      ).rejects.toThrow(ProblemDetailsException);

      await expect(
        controller.getEventHistory(mockClaims, nonExistentId),
      ).rejects.toThrow(ProblemDetailsException);
    });
  });
});

