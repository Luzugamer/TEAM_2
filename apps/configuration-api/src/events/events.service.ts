import { Injectable, Logger } from '@nestjs/common';
import { EventsRepository, OutboxRecordInput } from './events.repository';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { DuplicateEventDto } from './dto/duplicate-event.dto';
import { CancelEventDto } from './dto/cancel-event.dto';
import { CloseEventDto } from './dto/close-event.dto';
import { ArchiveEventDto } from './dto/archive-event.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { EventResponseDto, EventListResponseDto } from './dto/event-response.dto';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { AssignmentResponseDto } from './dto/assignment-response.dto';
import { AuditResponseDto } from './dto/audit-response.dto';
import { EventHistoryResponseDto } from './dto/event-history-response.dto';
import { AssignmentEntity } from './models/assignment.entity';
import { EventRevisionEntity } from './models/event-revision.entity';
import { MembershipAdapter } from './membership.adapter';
import { TenantClaims } from '../shared/auth/tenant-claims.interface';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';
import { generateUuidV7 } from '../shared/crypto/uuidv7';
import { computeSha256 } from '../shared/crypto/canonical-json';
import { EventStatus } from './models/event-status.enum';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    private readonly repository: EventsRepository,
    private readonly membershipAdapter: MembershipAdapter = new MembershipAdapter(),
  ) {}

  async createEvent(
    claims: TenantClaims,
    dto: CreateEventDto,
    idempotencyKey?: string,
  ): Promise<EventResponseDto> {
    // 1. Validate date order: starts_at < ends_at
    const startsAtDate = new Date(dto.starts_at);
    const endsAtDate = new Date(dto.ends_at);

    if (isNaN(startsAtDate.getTime()) || isNaN(endsAtDate.getTime())) {
      throw ProblemDetailsException.badRequest('Invalid ISO 8601 date string provided for starts_at or ends_at.');
    }

    if (startsAtDate >= endsAtDate) {
      throw ProblemDetailsException.unprocessable(
        'Event start date (starts_at) must be strictly earlier than end date (ends_at).',
        [
          { name: 'starts_at', reason: 'Must be before ends_at' },
          { name: 'ends_at', reason: 'Must be after starts_at' },
        ],
      );
    }

    // 2. Validate IANA Timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: dto.timezone });
    } catch (e) {
      throw ProblemDetailsException.unprocessable(
        `Invalid IANA timezone identifier: '${dto.timezone}'`,
        [{ name: 'timezone', reason: 'Must be a valid IANA timezone string (e.g., America/Lima, UTC)' }],
      );
    }

    // 3. Validate Slug Uniqueness within Tenant & Site
    const existing = await this.repository.findBySlug(claims.organization_id, dto.site_id, dto.slug);
    if (existing) {
      throw ProblemDetailsException.conflict(
        `An event with slug '${dto.slug}' already exists for site '${dto.site_id}' within this organization.`,
        'SLUG_ALREADY_EXISTS',
      );
    }

    // 4. Create Event & Initial Revision (Revision 1)
    const eventId = generateUuidV7();
    const revisionId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const snapshot = {
      id: eventId,
      site_id: dto.site_id,
      slug: dto.slug,
      kind: dto.kind,
      title: dto.title,
      description: dto.description || null,
      timezone: dto.timezone,
      starts_at: dto.starts_at,
      ends_at: dto.ends_at,
      status: EventStatus.DRAFT,
      policy: dto.policy || {},
      metadata: dto.metadata || {},
    };

    const initialRevision: EventRevisionEntity = {
      id: revisionId,
      organization_id: claims.organization_id,
      event_id: eventId,
      revision_number: 1,
      snapshot,
      change_summary: 'Initial event creation in draft state.',
      created_by: claims.sub,
      created_at: nowIso,
    };

    const event = {
      id: eventId,
      organization_id: claims.organization_id,
      site_id: dto.site_id,
      slug: dto.slug,
      kind: dto.kind,
      title: dto.title,
      description: dto.description || null,
      timezone: dto.timezone,
      starts_at: dto.starts_at,
      ends_at: dto.ends_at,
      status: EventStatus.DRAFT,
      current_revision_id: revisionId,
      revision_number: 1,
      policy: dto.policy || {},
      cancellation_reason: null,
      metadata: dto.metadata || {},
      created_at: nowIso,
      updated_at: nowIso,
    };

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'event',
      entity_id: eventId,
      action: 'CREATE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      idempotency_key: idempotencyKey,
      revision_number: 1,
      diff: { created: snapshot },
      payload_hash: computeSha256(dto),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    const savedEvent = await this.repository.createEvent(event, initialRevision, auditEntry);

    this.logger.log(`Created event draft ${savedEvent.id} for tenant ${claims.organization_id} by ${claims.sub}`);
    return savedEvent;
  }

  async listEvents(claims: TenantClaims, query: ListEventsQueryDto): Promise<EventListResponseDto> {
    const { items, hasNextPage, nextCursor } = await this.repository.listEvents(
      claims.organization_id,
      query,
    );

    return {
      items,
      page_info: {
        has_next_page: hasNextPage,
        next_cursor: nextCursor,
      },
    };
  }

  async getEventById(claims: TenantClaims, eventId: string): Promise<EventResponseDto> {
    const event = await this.repository.findById(claims.organization_id, eventId);
    if (!event) {
      throw ProblemDetailsException.notFound(
        `Event '${eventId}' was not found in the current organization.`,
        'EVENT_NOT_FOUND',
      );
    }
    return event;
  }

  async updateEvent(
    claims: TenantClaims,
    eventId: string,
    expectedRevision: number,
    dto: UpdateEventDto,
  ): Promise<EventResponseDto> {
    // 1. Fetch current event to verify existence and tenant isolation
    const current = await this.getEventById(claims, eventId);

    // 2. Check state machine: terminal states (archived / cancelled) cannot be modified
    if (current.status === EventStatus.ARCHIVED || current.status === EventStatus.CANCELLED) {
      throw ProblemDetailsException.unprocessable(
        `Cannot edit event '${eventId}': event is in immutable terminal state '${current.status}'.`,
        [{ name: 'status', reason: `Terminal state '${current.status}' is immutable` }],
      );
    }

    // 3. Optimistic Concurrency Check (If-Match vs current revision)
    if (current.revision_number !== expectedRevision) {
      throw ProblemDetailsException.preconditionFailed(
        `Precondition Failed: event '${eventId}' current revision is ${current.revision_number}, but expected ${expectedRevision}.`,
        'REVISION_MISMATCH',
      );
    }

    // 4. Validate dates if updated
    const startsAt = dto.starts_at || current.starts_at;
    const endsAt = dto.ends_at || current.ends_at;
    const startsAtDate = new Date(startsAt);
    const endsAtDate = new Date(endsAt);

    if (isNaN(startsAtDate.getTime()) || isNaN(endsAtDate.getTime())) {
      throw ProblemDetailsException.badRequest('Invalid ISO 8601 date string provided for starts_at or ends_at.');
    }

    if (startsAtDate >= endsAtDate) {
      throw ProblemDetailsException.unprocessable(
        'Event start date (starts_at) must be strictly earlier than end date (ends_at).',
        [
          { name: 'starts_at', reason: 'Must be before ends_at' },
          { name: 'ends_at', reason: 'Must be after starts_at' },
        ],
      );
    }

    // 5. Validate IANA timezone if updated
    if (dto.timezone) {
      try {
        Intl.DateTimeFormat(undefined, { timeZone: dto.timezone });
      } catch (e) {
        throw ProblemDetailsException.unprocessable(
          `Invalid IANA timezone identifier: '${dto.timezone}'`,
          [{ name: 'timezone', reason: 'Must be a valid IANA timezone string (e.g., America/Lima, UTC)' }],
        );
      }
    }

    // 6. Validate slug uniqueness within site and tenant if slug is modified
    if (dto.slug && dto.slug !== current.slug) {
      const existing = await this.repository.findBySlug(claims.organization_id, current.site_id, dto.slug);
      if (existing) {
        throw ProblemDetailsException.conflict(
          `An event with slug '${dto.slug}' already exists for site '${current.site_id}' within this organization.`,
          'SLUG_ALREADY_EXISTS',
        );
      }
    }

    // 7. Increment revision and prepare immutable revision snapshot
    const nextRevisionNumber = current.revision_number + 1;
    const newRevisionId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const newSnapshot: Record<string, unknown> = {
      id: current.id,
      site_id: current.site_id,
      slug: dto.slug || current.slug,
      kind: dto.kind || current.kind,
      title: dto.title || current.title,
      description: dto.description !== undefined ? dto.description : current.description,
      timezone: dto.timezone || current.timezone,
      starts_at: startsAt,
      ends_at: endsAt,
      status: current.status,
      policy: dto.policy ? { ...current.policy, ...dto.policy } : current.policy,
      metadata: dto.metadata ? { ...current.metadata, ...dto.metadata } : current.metadata,
    };

    const newRevision: EventRevisionEntity = {
      id: newRevisionId,
      organization_id: claims.organization_id,
      event_id: eventId,
      revision_number: nextRevisionNumber,
      snapshot: newSnapshot,
      change_summary: dto.change_summary || `Revision ${nextRevisionNumber}: metadata or rules updated.`,
      created_by: claims.sub,
      created_at: nowIso,
    };

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'event',
      entity_id: eventId,
      action: 'UPDATE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      revision_number: nextRevisionNumber,
      diff: {
        before: {
          title: current.title,
          description: current.description,
          slug: current.slug,
          starts_at: current.starts_at,
          ends_at: current.ends_at,
          revision_number: current.revision_number,
        },
        after: {
          title: newSnapshot.title,
          description: newSnapshot.description,
          slug: newSnapshot.slug,
          starts_at: newSnapshot.starts_at,
          ends_at: newSnapshot.ends_at,
          revision_number: nextRevisionNumber,
        },
      },
      payload_hash: computeSha256(dto),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    // 8. Persist atomically
    const updated = await this.repository.updateEventWithRevision(
      claims.organization_id,
      eventId,
      expectedRevision,
      {
        slug: newSnapshot.slug as string,
        kind: newSnapshot.kind as string,
        title: newSnapshot.title as string,
        description: newSnapshot.description as string | null,
        timezone: newSnapshot.timezone as string,
        starts_at: startsAt,
        ends_at: endsAt,
        policy: newSnapshot.policy as Record<string, unknown>,
        metadata: newSnapshot.metadata as Record<string, unknown>,
      },
      newRevision,
      auditEntry,
    );

    this.logger.log(`Updated event ${eventId} to revision ${nextRevisionNumber} for tenant ${claims.organization_id} by ${claims.sub}`);
    return updated;
  }

  async duplicateEvent(
    claims: TenantClaims,
    sourceEventId: string,
    dto: DuplicateEventDto,
    idempotencyKey?: string,
  ): Promise<EventResponseDto> {
    // 1. Fetch source event within tenant boundary (throws 404 if in another tenant or missing)
    const source = await this.getEventById(claims, sourceEventId);

    // 2. Validate dates for the new event: starts_at < ends_at
    const startsAtDate = new Date(dto.starts_at);
    const endsAtDate = new Date(dto.ends_at);

    if (isNaN(startsAtDate.getTime()) || isNaN(endsAtDate.getTime())) {
      throw ProblemDetailsException.badRequest('Invalid ISO 8601 date string provided for starts_at or ends_at.');
    }

    if (startsAtDate >= endsAtDate) {
      throw ProblemDetailsException.unprocessable(
        'Event start date (starts_at) must be strictly earlier than end date (ends_at).',
        [
          { name: 'starts_at', reason: 'Must be before ends_at' },
          { name: 'ends_at', reason: 'Must be after starts_at' },
        ],
      );
    }

    // 3. Resolve target site_id (default to source event site_id)
    const targetSiteId = dto.site_id || source.site_id;

    // 4. Validate slug uniqueness for the target site and organization
    const existing = await this.repository.findBySlug(claims.organization_id, targetSiteId, dto.slug);
    if (existing) {
      throw ProblemDetailsException.conflict(
        `An event with slug '${dto.slug}' already exists for site '${targetSiteId}' within this organization.`,
        'SLUG_ALREADY_EXISTS',
      );
    }

    // 5. Build new event in draft state, revision 1, fresh UUIDv7
    const newEventId = generateUuidV7();
    const revisionId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const title = dto.title || `${source.title} (Copia)`;
    const description = dto.description !== undefined ? dto.description : source.description;

    const clonedPolicy = JSON.parse(JSON.stringify(source.policy || {}));
    const newMetadata = {
      ...(source.metadata || {}),
      ...(dto.metadata || {}),
      duplicated_from: source.id,
      duplicated_at: nowIso,
    };

    const snapshot: Record<string, unknown> = {
      id: newEventId,
      site_id: targetSiteId,
      slug: dto.slug,
      kind: source.kind,
      title,
      description,
      timezone: source.timezone,
      starts_at: dto.starts_at,
      ends_at: dto.ends_at,
      status: EventStatus.DRAFT,
      policy: clonedPolicy,
      metadata: newMetadata,
    };

    const initialRevision: EventRevisionEntity = {
      id: revisionId,
      organization_id: claims.organization_id,
      event_id: newEventId,
      revision_number: 1,
      snapshot,
      change_summary: `Duplicated configuration from event '${source.title}' (${source.id}). Born in draft state.`,
      created_by: claims.sub,
      created_at: nowIso,
    };

    const newEvent = {
      id: newEventId,
      organization_id: claims.organization_id,
      site_id: targetSiteId,
      slug: dto.slug,
      kind: source.kind,
      title,
      description,
      timezone: source.timezone,
      starts_at: dto.starts_at,
      ends_at: dto.ends_at,
      status: EventStatus.DRAFT,
      current_revision_id: revisionId,
      revision_number: 1,
      policy: clonedPolicy,
      cancellation_reason: null,
      metadata: newMetadata,
      created_at: nowIso,
      updated_at: nowIso,
    };

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'event',
      entity_id: newEventId,
      action: 'DUPLICATE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      idempotency_key: idempotencyKey,
      revision_number: 1,
      diff: {
        source_event_id: source.id,
        new_event_id: newEventId,
        cloned_policy_keys: Object.keys(clonedPolicy),
      },
      payload_hash: computeSha256(dto),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    const saved = await this.repository.createEvent(newEvent, initialRevision, auditEntry);
    this.logger.log(`Duplicated event ${source.id} -> ${saved.id} (draft rev 1) for tenant ${claims.organization_id} by ${claims.sub}`);
    return saved;
  }

  async publishEvent(
    claims: TenantClaims,
    eventId: string,
    expectedRevision: number,
    idempotencyKey?: string,
  ): Promise<EventResponseDto> {
    const current = await this.getEventById(claims, eventId);

    // State machine: only draft or closed can transition to published
    if (current.status !== EventStatus.DRAFT && current.status !== EventStatus.CLOSED) {
      throw ProblemDetailsException.unprocessable(
        `Cannot publish event '${eventId}' from state '${current.status}'. Only draft or closed events can be published.`,
        [{ name: 'status', reason: `Invalid transition from ${current.status} to published` }],
      );
    }

    if (current.revision_number !== expectedRevision) {
      throw ProblemDetailsException.preconditionFailed(
        `Precondition Failed: event '${eventId}' current revision is ${current.revision_number}, but expected ${expectedRevision}.`,
        'REVISION_MISMATCH',
      );
    }

    const nextRevisionNumber = current.revision_number + 1;
    const newRevisionId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const newSnapshot: Record<string, unknown> = {
      ...current,
      status: EventStatus.PUBLISHED,
      revision_number: nextRevisionNumber,
      updated_at: nowIso,
    };

    const newRevision: EventRevisionEntity = {
      id: newRevisionId,
      organization_id: claims.organization_id,
      event_id: eventId,
      revision_number: nextRevisionNumber,
      snapshot: newSnapshot,
      change_summary: `Event status transitioned from ${current.status} to published (Revision ${nextRevisionNumber}).`,
      created_by: claims.sub,
      created_at: nowIso,
    };

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'event',
      entity_id: eventId,
      action: 'PUBLISH',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      idempotency_key: idempotencyKey,
      revision_number: nextRevisionNumber,
      diff: { status_transition: { from: current.status, to: EventStatus.PUBLISHED } },
      payload_hash: computeSha256({ expectedRevision }),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    const updated = await this.repository.updateEventWithRevision(
      claims.organization_id,
      eventId,
      expectedRevision,
      {
        status: EventStatus.PUBLISHED,
      },
      newRevision,
      auditEntry,
    );

    this.logger.log(`Published event ${eventId} (rev ${nextRevisionNumber}) for tenant ${claims.organization_id} by ${claims.sub}`);
    return updated;
  }

  async closeEvent(
    claims: TenantClaims,
    eventId: string,
    expectedRevision: number,
    dto: CloseEventDto,
    idempotencyKey?: string,
  ): Promise<EventResponseDto> {
    const current = await this.getEventById(claims, eventId);

    // State machine: published ⇄ closed
    if (current.status !== EventStatus.PUBLISHED) {
      throw ProblemDetailsException.unprocessable(
        `Cannot close registrations for event '${eventId}' from state '${current.status}'. Only published events can have registrations closed.`,
        [{ name: 'status', reason: `Invalid transition from ${current.status} to closed` }],
      );
    }

    if (current.revision_number !== expectedRevision) {
      throw ProblemDetailsException.preconditionFailed(
        `Precondition Failed: event '${eventId}' current revision is ${current.revision_number}, but expected ${expectedRevision}.`,
        'REVISION_MISMATCH',
      );
    }

    const nextRevisionNumber = current.revision_number + 1;
    const newRevisionId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const currentRegPolicy = (current.policy.registration as Record<string, unknown>) || {};
    const updatedPolicy: Record<string, unknown> = {
      ...current.policy,
      registration: {
        ...currentRegPolicy,
        status: 'closed',
        closed_at: nowIso,
        closure_reason: dto.reason || 'Registrations closed by organizer.',
      },
    };

    const newSnapshot: Record<string, unknown> = {
      ...current,
      status: EventStatus.CLOSED,
      policy: updatedPolicy,
      revision_number: nextRevisionNumber,
      updated_at: nowIso,
    };

    const newRevision: EventRevisionEntity = {
      id: newRevisionId,
      organization_id: claims.organization_id,
      event_id: eventId,
      revision_number: nextRevisionNumber,
      snapshot: newSnapshot,
      change_summary: dto.reason || `Registrations closed under revision ${nextRevisionNumber}.`,
      created_by: claims.sub,
      created_at: nowIso,
    };

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'event',
      entity_id: eventId,
      action: 'CLOSE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      idempotency_key: idempotencyKey,
      revision_number: nextRevisionNumber,
      diff: {
        status_transition: { from: current.status, to: EventStatus.CLOSED },
        policy: updatedPolicy,
      },
      payload_hash: computeSha256(dto),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    const updated = await this.repository.updateEventWithRevision(
      claims.organization_id,
      eventId,
      expectedRevision,
      {
        status: EventStatus.CLOSED,
        policy: updatedPolicy,
      },
      newRevision,
      auditEntry,
    );

    this.logger.log(`Closed registrations for event ${eventId} (rev ${nextRevisionNumber}) for tenant ${claims.organization_id} by ${claims.sub}`);
    return updated;
  }

  async cancelEvent(
    claims: TenantClaims,
    eventId: string,
    expectedRevision: number,
    dto: CancelEventDto,
    idempotencyKey?: string,
    cancellationReleaseId?: string,
  ): Promise<EventResponseDto> {
    const current = await this.getEventById(claims, eventId);

    // State machine: draft/published/closed → cancelled
    if (current.status === EventStatus.CANCELLED) {
      throw ProblemDetailsException.unprocessable(
        `Event '${eventId}' is already cancelled.`,
        [{ name: 'status', reason: 'Event is already cancelled' }],
      );
    }

    if (current.status === EventStatus.ARCHIVED) {
      throw ProblemDetailsException.unprocessable(
        `Cannot cancel event '${eventId}': archived events are in a permanent terminal state.`,
        [{ name: 'status', reason: 'Cannot cancel an archived event' }],
      );
    }

    if (current.revision_number !== expectedRevision) {
      throw ProblemDetailsException.preconditionFailed(
        `Precondition Failed: event '${eventId}' current revision is ${current.revision_number}, but expected ${expectedRevision}.`,
        'REVISION_MISMATCH',
      );
    }

    const nextRevisionNumber = current.revision_number + 1;
    const newRevisionId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const newSnapshot: Record<string, unknown> = {
      ...current,
      status: EventStatus.CANCELLED,
      cancellation_reason: dto.reason,
      revision_number: nextRevisionNumber,
      updated_at: nowIso,
    };

    const newRevision: EventRevisionEntity = {
      id: newRevisionId,
      organization_id: claims.organization_id,
      event_id: eventId,
      revision_number: nextRevisionNumber,
      snapshot: newSnapshot,
      change_summary: `Event cancelled: ${dto.reason}`,
      created_by: claims.sub,
      created_at: nowIso,
    };

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'event',
      entity_id: eventId,
      action: 'CANCEL',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      idempotency_key: idempotencyKey,
      revision_number: nextRevisionNumber,
      diff: {
        status_transition: { from: current.status, to: EventStatus.CANCELLED },
        reason: dto.reason,
      },
      payload_hash: computeSha256(dto),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    // Canonical pending relay message. The outbox commit is not broker delivery.
    const messageId = generateUuidV7();
    const outboxPayload = {
      message_id: messageId,
      domain_event_id: messageId,
      topic: 'configuration.event.cancelled.v1',
      schema_version: 1,
      producer: 'configuration',
      organization_id: claims.organization_id,
      business_event_id: eventId,
      occurred_at: nowIso,
      published_at: nowIso,
      actor: { type: 'user', id: claims.sub },
      traceparent: null,
      correlation_id: claims.request_id || messageId,
      causation_id: claims.request_id || null,
      aggregate: { type: 'event', id: eventId, version: nextRevisionNumber },
      partition_key: `${claims.organization_id}:${eventId}`,
      data: {
        event_id: eventId,
        release_id: cancellationReleaseId || null,
        reason_code: 'ORGANIZER_CANCELLED',
        effective_at: dto.effective_at || nowIso,
      },
    };

    const outboxEntry: OutboxRecordInput = {
      id: generateUuidV7(),
      organization_id: claims.organization_id,
      event_type: 'configuration.event.cancelled.v1',
      aggregate_type: 'event',
      aggregate_id: eventId,
      payload: outboxPayload,
      headers: {
        trace_id: claims.request_id || null,
        idempotency_key: idempotencyKey || null,
        actor_id: claims.sub,
      },
      status: 'pending',
    };

    const updated = await this.repository.updateEventWithRevision(
      claims.organization_id,
      eventId,
      expectedRevision,
      {
        status: EventStatus.CANCELLED,
        cancellation_reason: dto.reason,
      },
      newRevision,
      auditEntry,
      outboxEntry,
    );

    this.logger.log(`Cancelled event ${eventId} (rev ${nextRevisionNumber}) with reason '${dto.reason}' and staged outbox event.`);
    return updated;
  }

  async archiveEvent(
    claims: TenantClaims,
    eventId: string,
    expectedRevision: number,
    dto: ArchiveEventDto,
    idempotencyKey?: string,
  ): Promise<EventResponseDto> {
    const current = await this.getEventById(claims, eventId);

    // State machine: sólo closed o cancelled pasa a archived
    if (current.status !== EventStatus.CLOSED && current.status !== EventStatus.CANCELLED) {
      throw ProblemDetailsException.unprocessable(
        `Cannot archive event '${eventId}' from state '${current.status}'. Only closed or cancelled events can be archived.`,
        [{ name: 'status', reason: `Invalid transition from ${current.status} to archived` }],
      );
    }

    if (current.revision_number !== expectedRevision) {
      throw ProblemDetailsException.preconditionFailed(
        `Precondition Failed: event '${eventId}' current revision is ${current.revision_number}, but expected ${expectedRevision}.`,
        'REVISION_MISMATCH',
      );
    }

    const nextRevisionNumber = current.revision_number + 1;
    const newRevisionId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const newSnapshot: Record<string, unknown> = {
      ...current,
      status: EventStatus.ARCHIVED,
      revision_number: nextRevisionNumber,
      updated_at: nowIso,
    };

    const newRevision: EventRevisionEntity = {
      id: newRevisionId,
      organization_id: claims.organization_id,
      event_id: eventId,
      revision_number: nextRevisionNumber,
      snapshot: newSnapshot,
      change_summary: dto.reason || `Event archived permanently under revision ${nextRevisionNumber}.`,
      created_by: claims.sub,
      created_at: nowIso,
    };

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'event',
      entity_id: eventId,
      action: 'ARCHIVE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      idempotency_key: idempotencyKey,
      revision_number: nextRevisionNumber,
      diff: {
        status_transition: { from: current.status, to: EventStatus.ARCHIVED },
        reason: dto.reason || null,
      },
      payload_hash: computeSha256(dto),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    const updated = await this.repository.updateEventWithRevision(
      claims.organization_id,
      eventId,
      expectedRevision,
      {
        status: EventStatus.ARCHIVED,
      },
      newRevision,
      auditEntry,
    );

    this.logger.log(`Archived event ${eventId} (rev ${nextRevisionNumber}) for tenant ${claims.organization_id} by ${claims.sub}`);
    return updated;
  }

  async getRevisions(claims: TenantClaims, eventId: string): Promise<EventRevisionEntity[]> {
    // Check existence in tenant first
    await this.getEventById(claims, eventId);
    return await this.repository.getRevisions(claims.organization_id, eventId);
  }

  /**
   * Contract method: EventSnapshotProvider for ReleaseAssembler.
   * Reads immutable snapshot and verifies expected revision.
   */
  async readEventSnapshot(
    organizationId: string,
    eventId: string,
    expectedRevision?: number,
  ): Promise<{ snapshot: EventResponseDto; hash: string }> {
    const event = await this.repository.findById(organizationId, eventId);
    if (!event) {
      throw ProblemDetailsException.notFound(
        `Event '${eventId}' not found for snapshot assembly.`,
        'EVENT_NOT_FOUND',
      );
    }

    if (expectedRevision !== undefined && event.revision_number !== expectedRevision) {
      throw ProblemDetailsException.preconditionFailed(
        `Event revision mismatch: current revision is ${event.revision_number}, but expected ${expectedRevision}.`,
        'REVISION_MISMATCH',
      );
    }

    const hash = computeSha256(event);
    return { snapshot: event, hash };
  }

  /**
   * EC-006: Assigns a responsible user or role to an event or site with active membership,
   * minimum scopes, and validity boundaries.
   */
  async createAssignment(
    claims: TenantClaims,
    eventId: string,
    dto: CreateAssignmentDto,
    idempotencyKey?: string,
  ): Promise<AssignmentResponseDto> {
    // 1. Ensure target event exists within tenant isolation
    const event = await this.getEventById(claims, eventId);

    // 2. Temporal validation
    const validFromDate = dto.valid_from ? new Date(dto.valid_from) : new Date();
    if (isNaN(validFromDate.getTime())) {
      throw ProblemDetailsException.badRequest('Invalid ISO 8601 date string provided for valid_from.');
    }

    let validToDate: Date | null = null;
    if (dto.valid_to) {
      validToDate = new Date(dto.valid_to);
      if (isNaN(validToDate.getTime())) {
        throw ProblemDetailsException.badRequest('Invalid ISO 8601 date string provided for valid_to.');
      }
      if (validFromDate >= validToDate) {
        throw ProblemDetailsException.unprocessable(
          'Assignment valid_from must be strictly earlier than valid_to.',
          [
            { name: 'valid_from', reason: 'Must be before valid_to' },
            { name: 'valid_to', reason: 'Must be after valid_from' },
          ],
        );
      }
    }

    // 3. Validate active membership within tenant
    const membershipCheck = await this.membershipAdapter.validateActiveMembership(
      claims.organization_id,
      dto.user_id,
    );
    if (!membershipCheck.isValid) {
      throw ProblemDetailsException.unprocessable(
        membershipCheck.reason || 'User does not possess an active membership in this organization.',
        [{ name: 'user_id', reason: membershipCheck.reason || 'Invalid membership' }],
      );
    }

    // 4. Construct assignment entity
    const assignmentId = generateUuidV7();
    const nowIso = new Date().toISOString();

    const assignment: AssignmentEntity = {
      id: assignmentId,
      organization_id: claims.organization_id,
      event_id: eventId,
      site_id: dto.site_id || event.site_id || null,
      user_id: dto.user_id,
      role: dto.role,
      scopes: dto.scopes,
      valid_from: validFromDate.toISOString(),
      valid_to: validToDate ? validToDate.toISOString() : null,
      is_active: true,
      created_by: claims.sub,
      created_at: nowIso,
      updated_at: nowIso,
    };

    // 5. Append-only audit record
    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'assignment',
      entity_id: assignmentId,
      action: 'ASSIGN_ROLE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id || generateUuidV7(),
      idempotency_key: idempotencyKey,
      revision_number: event.revision_number,
      diff: {
        event_id: eventId,
        user_id: dto.user_id,
        role: dto.role,
        scopes: dto.scopes,
        valid_from: assignment.valid_from,
        valid_to: assignment.valid_to,
      },
      payload_hash: computeSha256(dto),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    const created = await this.repository.createAssignment(assignment, auditEntry);
    this.logger.log(
      `Created assignment ${assignmentId} for user ${dto.user_id} on event ${eventId} in tenant ${claims.organization_id} by ${claims.sub}`,
    );
    return created;
  }

  /**
   * EC-006: Lists all assignments (active and revoked) for a specific event.
   */
  async listAssignments(claims: TenantClaims, eventId: string): Promise<AssignmentResponseDto[]> {
    await this.getEventById(claims, eventId);
    return await this.repository.listAssignments(claims.organization_id, eventId);
  }

  /**
   * EC-006: Revokes an assignment securely, marking is_active = false and writing append-only audit.
   */
  async revokeAssignment(
    claims: TenantClaims,
    eventId: string,
    assignmentId: string,
    idempotencyKey?: string,
  ): Promise<AssignmentResponseDto> {
    await this.getEventById(claims, eventId);

    const current = await this.repository.findAssignmentById(claims.organization_id, assignmentId);
    if (!current || current.event_id !== eventId) {
      throw ProblemDetailsException.notFound(
        `Assignment '${assignmentId}' was not found for event '${eventId}'.`,
        'ASSIGNMENT_NOT_FOUND',
      );
    }

    if (!current.is_active) {
      return current;
    }

    const currentEvent = await this.getEventById(claims, eventId);

    const auditEntry = {
      organization_id: claims.organization_id,
      entity_type: 'assignment',
      entity_id: assignmentId,
      action: 'REVOKE_ROLE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id || generateUuidV7(),
      idempotency_key: idempotencyKey,
      revision_number: currentEvent.revision_number,
      diff: {
        event_id: eventId,
        previous_status: true,
        new_status: false,
        revoked_by: claims.sub,
      },
      payload_hash: computeSha256({ assignmentId, action: 'REVOKE_ROLE' }),
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    const revoked = await this.repository.revokeAssignment(claims.organization_id, assignmentId, auditEntry);
    this.logger.log(
      `Revoked assignment ${assignmentId} for user ${current.user_id} on event ${eventId} by ${claims.sub}`,
    );
    return revoked;
  }

  /**
   * EC-006: Fast active permission check by organization, event, user, and required scope.
   */
  async checkUserEventAccess(
    organizationId: string,
    eventId: string,
    userId: string,
    requiredScope: string,
    atDate: Date = new Date(),
  ): Promise<boolean> {
    return await this.repository.hasActiveAssignment(organizationId, eventId, userId, requiredScope, atDate);
  }

  /**
   * EC-041: Retrieves append-only audit trail records for an event.
   * Ensures multi-tenant isolation and checks event existence.
   */
  async getAuditTrail(claims: TenantClaims, eventId: string): Promise<AuditResponseDto[]> {
    await this.getEventById(claims, eventId);
    return await this.repository.getAuditTrail(claims.organization_id, eventId);
  }

  /**
   * EC-041: Retrieves complete event history comprising all immutable revisions
   * and chronological audit trail.
   */
  async getEventHistory(claims: TenantClaims, eventId: string): Promise<EventHistoryResponseDto> {
    const event = await this.getEventById(claims, eventId);
    const revisions = await this.repository.getRevisions(claims.organization_id, eventId);
    const audit_trail = await this.repository.getAuditTrail(claims.organization_id, eventId);

    return {
      event_id: event.id,
      organization_id: claims.organization_id,
      current_revision: event.revision_number,
      revisions,
      audit_trail,
    };
  }
}

