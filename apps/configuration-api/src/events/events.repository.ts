import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../shared/database/database.service';
import { EventEntity } from './models/event.entity';
import { EventRevisionEntity } from './models/event-revision.entity';
import { AssignmentEntity } from './models/assignment.entity';
import { AuditEntity } from './models/audit.entity';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { EventStatus } from './models/event-status.enum';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';
import { generateUuidV7 } from '../shared/crypto/uuidv7';
import { sql } from 'kysely';

export interface AuditRecordInput {
  id?: string;
  organization_id: string;
  entity_type: string;
  entity_id: string;
  action: string;
  actor_id: string;
  actor_roles: string[];
  request_id?: string;
  idempotency_key?: string;
  revision_number?: number;
  diff?: Record<string, unknown> | null;
  payload_hash?: string;
  client_ip?: string;
  user_agent?: string;
  created_at?: string;
}

export interface OutboxRecordInput {
  id?: string;
  organization_id: string;
  event_type: string;
  aggregate_type: string;
  aggregate_id: string;
  payload: Record<string, unknown>;
  headers?: Record<string, unknown>;
  status?: 'pending' | 'delivered' | 'failed';
}

@Injectable()
export class EventsRepository {
  private readonly logger = new Logger(EventsRepository.name);

  // In-memory fallback storage for disconnected/testing environments
  private eventsStore = new Map<string, EventEntity>();
  private revisionsStore = new Map<string, EventRevisionEntity[]>();
  private auditStore: AuditRecordInput[] = [];
  private outboxStore: OutboxRecordInput[] = [];
  private assignmentsStore = new Map<string, AssignmentEntity>();

  constructor(private readonly databaseService: DatabaseService) {}

  async findById(organizationId: string, eventId: string): Promise<EventEntity | null> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const row = await db
        .selectFrom('events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', eventId)
        .executeTakeFirst();

      if (!row) return null;

      return {
        id: row.id,
        organization_id: row.organization_id,
        site_id: row.site_id,
        slug: row.slug,
        kind: row.kind,
        title: row.title,
        description: row.description,
        timezone: row.timezone,
        starts_at: new Date(row.starts_at).toISOString(),
        ends_at: new Date(row.ends_at).toISOString(),
        status: row.status as EventStatus,
        current_revision_id: row.current_revision_id,
        revision_number: row.revision_number,
        policy: (row.policy as Record<string, unknown>) || {},
        cancellation_reason: row.cancellation_reason,
        metadata: (row.metadata as Record<string, unknown>) || {},
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      };
          });
    }

    const event = this.eventsStore.get(eventId);
    if (!event || event.organization_id !== organizationId) {
      return null;
    }
    return event;
  }

  async findBySlug(organizationId: string, siteId: string, slug: string): Promise<EventEntity | null> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const row = await db
        .selectFrom('events')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('site_id', '=', siteId)
        .where('slug', '=', slug)
        .executeTakeFirst();

      if (!row) return null;

      return {
        id: row.id,
        organization_id: row.organization_id,
        site_id: row.site_id,
        slug: row.slug,
        kind: row.kind,
        title: row.title,
        description: row.description,
        timezone: row.timezone,
        starts_at: new Date(row.starts_at).toISOString(),
        ends_at: new Date(row.ends_at).toISOString(),
        status: row.status as EventStatus,
        current_revision_id: row.current_revision_id,
        revision_number: row.revision_number,
        policy: (row.policy as Record<string, unknown>) || {},
        cancellation_reason: row.cancellation_reason,
        metadata: (row.metadata as Record<string, unknown>) || {},
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      };
          });
    }

    for (const event of this.eventsStore.values()) {
      if (
        event.organization_id === organizationId &&
        event.site_id === siteId &&
        event.slug === slug
      ) {
        return event;
      }
    }
    return null;
  }

  async createEvent(event: EventEntity, revision: EventRevisionEntity, audit: AuditRecordInput): Promise<EventEntity> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(
        event.organization_id,
        async (trx) => {
          // 1. Insert Event
          await trx
            .insertInto('events')
            .values({
              id: event.id,
              organization_id: event.organization_id,
              site_id: event.site_id,
              slug: event.slug,
              kind: event.kind,
              title: event.title,
              description: event.description,
              timezone: event.timezone,
              starts_at: new Date(event.starts_at),
              ends_at: new Date(event.ends_at),
              status: event.status,
              current_revision_id: null,
              revision_number: event.revision_number,
              policy: event.policy,
              cancellation_reason: null,
              metadata: event.metadata,
              created_at: new Date(event.created_at),
              updated_at: new Date(event.updated_at),
            })
            .execute();

          // 2. Insert Revision
          await trx
            .insertInto('event_revisions')
            .values({
              id: revision.id,
              organization_id: revision.organization_id,
              event_id: event.id,
              revision_number: revision.revision_number,
              snapshot: revision.snapshot,
              change_summary: revision.change_summary,
              created_by: revision.created_by,
              created_at: new Date(revision.created_at),
            })
            .execute();

          // 3. Link current revision
          await trx
            .updateTable('events')
            .set({ current_revision_id: revision.id })
            .where('organization_id', '=', event.organization_id)
            .where('id', '=', event.id)
            .execute();

          // 4. Record Audit
          await trx
            .insertInto('audit')
            .values({
              organization_id: audit.organization_id,
              entity_type: audit.entity_type,
              entity_id: audit.entity_id,
              action: audit.action,
              actor_id: audit.actor_id,
              actor_roles: audit.actor_roles,
              request_id: audit.request_id || null,
              idempotency_key: audit.idempotency_key || null,
              revision_number: audit.revision_number || null,
              diff: audit.diff || null,
              payload_hash: audit.payload_hash || null,
              client_ip: audit.client_ip || null,
              user_agent: audit.user_agent || null,
              created_at: new Date(),
            })
            .execute();

          return {
            ...event,
            current_revision_id: revision.id,
          };
        },
      );
    }

    // In-Memory transaction fallback
    const savedEvent = { ...event, current_revision_id: revision.id };
    this.eventsStore.set(event.id, savedEvent);
    const revs = this.revisionsStore.get(event.id) || [];
    revs.push(revision);
    this.revisionsStore.set(event.id, revs);
    this.auditStore.push({
      ...audit,
      id: audit.id || generateUuidV7(),
      created_at: audit.created_at || new Date().toISOString(),
    });
    return savedEvent;
  }

  async listEvents(
    organizationId: string,
    query: ListEventsQueryDto,
  ): Promise<{ items: EventEntity[]; hasNextPage: boolean; nextCursor: string | null }> {
    const limit = query.limit || 20;

    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      let q = db
        .selectFrom('events')
        .selectAll()
        .where('organization_id', '=', organizationId);

      if (query.site_id) {
        q = q.where('site_id', '=', query.site_id);
      }
      if (query.kind) {
        q = q.where('kind', '=', query.kind);
      }
      if (query.status) {
        q = q.where('status', '=', query.status);
      }
      if (query.from_date) {
        q = q.where('starts_at', '>=', new Date(query.from_date));
      }
      if (query.to_date) {
        q = q.where('ends_at', '<=', new Date(query.to_date));
      }

      if (query.cursor) {
        try {
          const decoded = Buffer.from(query.cursor, 'base64').toString('utf8');
          const [cursorStartsAt, cursorId] = decoded.split('#');
          if (cursorStartsAt && cursorId) {
            const cursorDate = new Date(cursorStartsAt);
            q = q.where((eb) =>
              eb.or([
                eb('starts_at', '>', cursorDate),
                eb.and([
                  eb('starts_at', '=', cursorDate),
                  eb('id', '>', cursorId),
                ]),
              ]),
            );
          }
        } catch (e) {
          this.logger.warn(`Invalid cursor format: ${query.cursor}`);
        }
      }

      q = q
        .orderBy('starts_at', 'asc')
        .orderBy('id', 'asc')
        .limit(limit + 1);

      const rows = await q.execute();
      const hasNextPage = rows.length > limit;
      const sliced = hasNextPage ? rows.slice(0, limit) : rows;

      const items: EventEntity[] = sliced.map((row) => ({
        id: row.id,
        organization_id: row.organization_id,
        site_id: row.site_id,
        slug: row.slug,
        kind: row.kind,
        title: row.title,
        description: row.description,
        timezone: row.timezone,
        starts_at: new Date(row.starts_at).toISOString(),
        ends_at: new Date(row.ends_at).toISOString(),
        status: row.status as EventStatus,
        current_revision_id: row.current_revision_id,
        revision_number: row.revision_number,
        policy: (row.policy as Record<string, unknown>) || {},
        cancellation_reason: row.cancellation_reason,
        metadata: (row.metadata as Record<string, unknown>) || {},
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      }));

      let nextCursor: string | null = null;
      if (hasNextPage && items.length > 0) {
        const last = items[items.length - 1];
        nextCursor = Buffer.from(`${last.starts_at}#${last.id}`).toString('base64');
      }

      return { items, hasNextPage, nextCursor };
          });
    }

    // In-memory listing fallback with cursor pagination
    let all = Array.from(this.eventsStore.values()).filter(
      (e) => e.organization_id === organizationId,
    );

    if (query.site_id) {
      all = all.filter((e) => e.site_id === query.site_id);
    }
    if (query.kind) {
      all = all.filter((e) => e.kind === query.kind);
    }
    if (query.status) {
      all = all.filter((e) => e.status === query.status);
    }
    if (query.from_date) {
      all = all.filter((e) => e.starts_at >= query.from_date!);
    }
    if (query.to_date) {
      all = all.filter((e) => e.ends_at <= query.to_date!);
    }

    all.sort((a, b) => {
      if (a.starts_at === b.starts_at) {
        return a.id.localeCompare(b.id);
      }
      return a.starts_at.localeCompare(b.starts_at);
    });

    if (query.cursor) {
      try {
        const decoded = Buffer.from(query.cursor, 'base64').toString('utf8');
        const [cursorStartsAt, cursorId] = decoded.split('#');
        const index = all.findIndex(
          (e) => e.starts_at > cursorStartsAt || (e.starts_at === cursorStartsAt && e.id > cursorId),
        );
        if (index >= 0) {
          all = all.slice(index);
        } else {
          all = [];
        }
      } catch (e) {
        this.logger.warn(`Invalid cursor format in memory filter: ${query.cursor}`);
      }
    }

    const hasNextPage = all.length > limit;
    const items = hasNextPage ? all.slice(0, limit) : all;

    let nextCursor: string | null = null;
    if (hasNextPage && items.length > 0) {
      const last = items[items.length - 1];
      nextCursor = Buffer.from(`${last.starts_at}#${last.id}`).toString('base64');
    }

    return { items, hasNextPage, nextCursor };
  }

  async updateEventWithRevision(
    organizationId: string,
    eventId: string,
    expectedRevision: number,
    updatedEvent: Partial<EventEntity>,
    newRevision: EventRevisionEntity,
    audit: AuditRecordInput,
    outboxEntry?: OutboxRecordInput,
  ): Promise<EventEntity> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(
        organizationId,
        async (trx) => {
          // 1. Check current event and optimistic concurrency
          const current = await trx
            .selectFrom('events')
            .selectAll()
            .where('organization_id', '=', organizationId)
            .where('id', '=', eventId)
            .executeTakeFirst();

          if (!current) {
            throw ProblemDetailsException.notFound(
              `Event '${eventId}' was not found in the current organization.`,
              'EVENT_NOT_FOUND',
            );
          }

          if (current.revision_number !== expectedRevision) {
            throw ProblemDetailsException.preconditionFailed(
              `Precondition Failed: event '${eventId}' current revision is ${current.revision_number}, but expected ${expectedRevision}.`,
              'REVISION_MISMATCH',
            );
          }

          // 2. Perform atomic update guarded by revision_number
          const updateResult = await trx
            .updateTable('events')
            .set({
              ...(updatedEvent.slug ? { slug: updatedEvent.slug } : {}),
              ...(updatedEvent.kind ? { kind: updatedEvent.kind } : {}),
              ...(updatedEvent.title ? { title: updatedEvent.title } : {}),
              ...(updatedEvent.description !== undefined ? { description: updatedEvent.description } : {}),
              ...(updatedEvent.timezone ? { timezone: updatedEvent.timezone } : {}),
              ...(updatedEvent.starts_at ? { starts_at: new Date(updatedEvent.starts_at) } : {}),
              ...(updatedEvent.ends_at ? { ends_at: new Date(updatedEvent.ends_at) } : {}),
              ...(updatedEvent.status ? { status: updatedEvent.status } : {}),
              ...(updatedEvent.cancellation_reason !== undefined ? { cancellation_reason: updatedEvent.cancellation_reason } : {}),
              ...(updatedEvent.policy ? { policy: updatedEvent.policy } : {}),
              ...(updatedEvent.metadata ? { metadata: updatedEvent.metadata } : {}),
              current_revision_id: newRevision.id,
              revision_number: newRevision.revision_number,
              updated_at: new Date(),
            })
            .where('organization_id', '=', organizationId)
            .where('id', '=', eventId)
            .where('revision_number', '=', expectedRevision)
            .executeTakeFirst();

          if (updateResult.numUpdatedRows === 0n) {
            throw ProblemDetailsException.preconditionFailed(
              `Concurrent modification detected: event revision has already changed.`,
              'CONCURRENT_REVISION_CONFLICT',
            );
          }

          // 3. Insert new immutable revision
          await trx
            .insertInto('event_revisions')
            .values({
              id: newRevision.id,
              organization_id: newRevision.organization_id,
              event_id: eventId,
              revision_number: newRevision.revision_number,
              snapshot: newRevision.snapshot,
              change_summary: newRevision.change_summary,
              created_by: newRevision.created_by,
              created_at: new Date(newRevision.created_at),
            })
            .execute();

          // 4. Record append-only audit
          await trx
            .insertInto('audit')
            .values({
              organization_id: audit.organization_id,
              entity_type: audit.entity_type,
              entity_id: audit.entity_id,
              action: audit.action,
              actor_id: audit.actor_id,
              actor_roles: audit.actor_roles,
              request_id: audit.request_id || null,
              idempotency_key: audit.idempotency_key || null,
              revision_number: audit.revision_number || null,
              diff: audit.diff || null,
              payload_hash: audit.payload_hash || null,
              client_ip: audit.client_ip || null,
              user_agent: audit.user_agent || null,
              created_at: new Date(),
            })
            .execute();

          // 5. Record transactional outbox event if present
          if (outboxEntry) {
            await trx
              .insertInto('outbox')
              .values({
                id: outboxEntry.id || generateUuidV7(),
                organization_id: outboxEntry.organization_id,
                event_type: outboxEntry.event_type,
                aggregate_type: outboxEntry.aggregate_type,
                aggregate_id: outboxEntry.aggregate_id,
                payload: outboxEntry.payload,
                headers: outboxEntry.headers || {},
                status: outboxEntry.status || 'pending',
                retry_count: 0,
                max_retries: 5,
                next_retry_at: new Date(),
                delivered_at: null,
                last_error: null,
                created_at: new Date(),
              })
              .execute();
          }

          return (await this.findById(organizationId, eventId))!;
        },
      );
    }

    // In-memory fallback
    const current = this.eventsStore.get(eventId);
    if (!current || current.organization_id !== organizationId) {
      throw ProblemDetailsException.notFound(
        `Event '${eventId}' was not found in the current organization.`,
        'EVENT_NOT_FOUND',
      );
    }

    if (current.revision_number !== expectedRevision) {
      throw ProblemDetailsException.preconditionFailed(
        `Precondition Failed: event '${eventId}' current revision is ${current.revision_number}, but expected ${expectedRevision}.`,
        'REVISION_MISMATCH',
      );
    }

    const updated: EventEntity = {
      ...current,
      ...updatedEvent,
      revision_number: newRevision.revision_number,
      current_revision_id: newRevision.id,
      updated_at: new Date().toISOString(),
    };

    this.eventsStore.set(eventId, updated);

    // Append to revisions history (never overwrite)
    const revs = this.revisionsStore.get(eventId) || [];
    revs.push(newRevision);
    this.revisionsStore.set(eventId, revs);

    this.auditStore.push({
      ...audit,
      id: audit.id || generateUuidV7(),
      created_at: audit.created_at || new Date().toISOString(),
    });

    if (outboxEntry) {
      this.outboxStore.push({
        ...outboxEntry,
        id: outboxEntry.id || generateUuidV7(),
        status: outboxEntry.status || 'pending',
      });
    }

    return updated;
  }

  getOutbox(): OutboxRecordInput[] {
    return this.outboxStore;
  }

  getOutboxByAggregate(aggregateId: string): OutboxRecordInput[] {
    return this.outboxStore.filter((o) => o.aggregate_id === aggregateId);
  }

  async getRevisions(organizationId: string, eventId: string): Promise<EventRevisionEntity[]> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const rows = await db
        .selectFrom('event_revisions')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('event_id', '=', eventId)
        .orderBy('revision_number', 'desc')
        .execute();

      return rows.map((r) => ({
        id: r.id,
        organization_id: r.organization_id,
        event_id: r.event_id,
        revision_number: r.revision_number,
        snapshot: r.snapshot as Record<string, unknown>,
        change_summary: r.change_summary,
        created_by: r.created_by,
        created_at: new Date(r.created_at).toISOString(),
      }));
          });
    }

    const revs = this.revisionsStore.get(eventId) || [];
    return [...revs].sort((a, b) => b.revision_number - a.revision_number);
  }

  async createAssignment(assignment: AssignmentEntity, audit: AuditRecordInput): Promise<AssignmentEntity> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(
        assignment.organization_id,
        async (trx) => {
          await trx
            .insertInto('assignments')
            .values({
              id: assignment.id,
              organization_id: assignment.organization_id,
              event_id: assignment.event_id,
              site_id: assignment.site_id,
              user_id: assignment.user_id,
              role: assignment.role,
              scopes: assignment.scopes,
              valid_from: new Date(assignment.valid_from),
              valid_to: assignment.valid_to ? new Date(assignment.valid_to) : null,
              is_active: assignment.is_active,
              created_by: assignment.created_by,
              created_at: new Date(assignment.created_at),
              updated_at: new Date(assignment.updated_at),
            })
            .execute();

          await trx
            .insertInto('audit')
            .values({
              organization_id: audit.organization_id,
              entity_type: audit.entity_type,
              entity_id: audit.entity_id,
              action: audit.action,
              actor_id: audit.actor_id,
              actor_roles: audit.actor_roles,
              request_id: audit.request_id || null,
              idempotency_key: audit.idempotency_key || null,
              revision_number: null,
              diff: audit.diff || null,
              payload_hash: audit.payload_hash || null,
              client_ip: audit.client_ip || null,
              user_agent: audit.user_agent || null,
              created_at: new Date(),
            })
            .execute();

          return assignment;
        },
      );
    }

    this.assignmentsStore.set(assignment.id, assignment);
    this.auditStore.push({
      ...audit,
      id: audit.id || generateUuidV7(),
      created_at: audit.created_at || new Date().toISOString(),
    });
    return assignment;
  }

  async findAssignmentById(organizationId: string, assignmentId: string): Promise<AssignmentEntity | null> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const row = await db
        .selectFrom('assignments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', assignmentId)
        .executeTakeFirst();

      if (!row) return null;

      return {
        id: row.id,
        organization_id: row.organization_id,
        event_id: row.event_id,
        site_id: row.site_id,
        user_id: row.user_id,
        role: row.role,
        scopes: row.scopes,
        valid_from: new Date(row.valid_from).toISOString(),
        valid_to: row.valid_to ? new Date(row.valid_to).toISOString() : null,
        is_active: row.is_active,
        created_by: row.created_by,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      };
          });
    }

    const a = this.assignmentsStore.get(assignmentId);
    if (!a || a.organization_id !== organizationId) return null;
    return a;
  }

  async listAssignments(organizationId: string, eventId: string): Promise<AssignmentEntity[]> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const rows = await db
        .selectFrom('assignments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('event_id', '=', eventId)
        .orderBy('created_at', 'desc')
        .execute();

      return rows.map((row) => ({
        id: row.id,
        organization_id: row.organization_id,
        event_id: row.event_id,
        site_id: row.site_id,
        user_id: row.user_id,
        role: row.role,
        scopes: row.scopes,
        valid_from: new Date(row.valid_from).toISOString(),
        valid_to: row.valid_to ? new Date(row.valid_to).toISOString() : null,
        is_active: row.is_active,
        created_by: row.created_by,
        created_at: new Date(row.created_at).toISOString(),
        updated_at: new Date(row.updated_at).toISOString(),
      }));
          });
    }

    return Array.from(this.assignmentsStore.values())
      .filter((a) => a.organization_id === organizationId && a.event_id === eventId)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  async revokeAssignment(organizationId: string, assignmentId: string, audit: AuditRecordInput): Promise<AssignmentEntity> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(
        organizationId,
        async (trx) => {
          const row = await trx
            .updateTable('assignments')
            .set({
              is_active: false,
              updated_at: new Date(),
            })
            .where('organization_id', '=', organizationId)
            .where('id', '=', assignmentId)
            .returningAll()
            .executeTakeFirstOrThrow();

          await trx
            .insertInto('audit')
            .values({
              organization_id: audit.organization_id,
              entity_type: audit.entity_type,
              entity_id: audit.entity_id,
              action: audit.action,
              actor_id: audit.actor_id,
              actor_roles: audit.actor_roles,
              request_id: audit.request_id || null,
              idempotency_key: audit.idempotency_key || null,
              revision_number: null,
              diff: audit.diff || null,
              payload_hash: audit.payload_hash || null,
              client_ip: audit.client_ip || null,
              user_agent: audit.user_agent || null,
              created_at: new Date(),
            })
            .execute();

          return {
            id: row.id,
            organization_id: row.organization_id,
            event_id: row.event_id,
            site_id: row.site_id,
            user_id: row.user_id,
            role: row.role,
            scopes: row.scopes,
            valid_from: new Date(row.valid_from).toISOString(),
            valid_to: row.valid_to ? new Date(row.valid_to).toISOString() : null,
            is_active: row.is_active,
            created_by: row.created_by,
            created_at: new Date(row.created_at).toISOString(),
            updated_at: new Date(row.updated_at).toISOString(),
          };
        },
      );
    }

    const current = this.assignmentsStore.get(assignmentId);
    if (!current || current.organization_id !== organizationId) {
      throw ProblemDetailsException.notFound(
        `Assignment '${assignmentId}' was not found.`,
        'ASSIGNMENT_NOT_FOUND',
      );
    }

    const revoked: AssignmentEntity = {
      ...current,
      is_active: false,
      updated_at: new Date().toISOString(),
    };

    this.assignmentsStore.set(assignmentId, revoked);
    this.auditStore.push({
      ...audit,
      id: audit.id || generateUuidV7(),
      created_at: audit.created_at || new Date().toISOString(),
    });
    return revoked;
  }

  async hasActiveAssignment(
    organizationId: string,
    eventId: string,
    userId: string,
    requiredScope: string,
    atDate = new Date(),
  ): Promise<boolean> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const rows = await db
        .selectFrom('assignments')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('user_id', '=', userId)
        .where('is_active', '=', true)
        .where((eb) =>
          eb.or([
            eb('event_id', '=', eventId),
            eb('event_id', 'is', null),
          ]),
        )
        .execute();

      return rows.some((row) => {
        const from = new Date(row.valid_from);
        const to = row.valid_to ? new Date(row.valid_to) : null;
        const inWindow = atDate >= from && (to === null || atDate <= to);
        const hasScope = row.scopes.includes(requiredScope);
        return inWindow && hasScope;
      });
          });
    }

    const assignments = Array.from(this.assignmentsStore.values()).filter(
      (a) =>
        a.organization_id === organizationId &&
        a.user_id === userId &&
        a.is_active &&
        (a.event_id === eventId || a.event_id === null),
    );

    return assignments.some((a) => {
      const from = new Date(a.valid_from);
      const to = a.valid_to ? new Date(a.valid_to) : null;
      const inWindow = atDate >= from && (to === null || atDate <= to);
      const hasScope = a.scopes.includes(requiredScope);
      return inWindow && hasScope;
    });
  }

  /**
   * EC-041: Retrieves append-only audit trail entries for an event,
   * guaranteeing multi-tenant isolation and immutable history.
   */
  async getAuditTrail(organizationId: string, eventId: string): Promise<AuditEntity[]> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const rows = await db
        .selectFrom('audit')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where((eb) =>
          eb.or([
            eb('entity_id', '=', eventId),
            sql<boolean>`diff->>'event_id' = ${eventId}`,
            sql<boolean>`diff->'diff'->>'event_id' = ${eventId}`,
            sql<boolean>`diff->>'source_event_id' = ${eventId}`,
            sql<boolean>`diff->>'new_event_id' = ${eventId}`,
          ]),
        )
        .orderBy('created_at', 'desc')
        .execute();

      return rows.map((r) => ({
        id: r.id,
        organization_id: r.organization_id,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        action: r.action,
        actor_id: r.actor_id,
        actor_roles: r.actor_roles,
        request_id: r.request_id,
        idempotency_key: r.idempotency_key,
        revision_number: r.revision_number,
        diff: r.diff as Record<string, unknown> | null,
        payload_hash: r.payload_hash,
        client_ip: r.client_ip,
        user_agent: r.user_agent,
        created_at: new Date(r.created_at).toISOString(),
      }));
          });
    }

    return this.auditStore
      .filter(
        (a) =>
          a.organization_id === organizationId &&
          (a.entity_id === eventId ||
            a.diff?.['event_id'] === eventId ||
            (a.diff?.['diff'] as any)?.['event_id'] === eventId ||
            a.diff?.['source_event_id'] === eventId ||
            a.diff?.['new_event_id'] === eventId),
      )
      .map((a) => ({
        id: a.id || generateUuidV7(),
        organization_id: a.organization_id,
        entity_type: a.entity_type,
        entity_id: a.entity_id,
        action: a.action,
        actor_id: a.actor_id,
        actor_roles: a.actor_roles,
        request_id: a.request_id || null,
        idempotency_key: a.idempotency_key || null,
        revision_number: a.revision_number || null,
        diff: a.diff || null,
        payload_hash: a.payload_hash || null,
        client_ip: a.client_ip || null,
        user_agent: a.user_agent || null,
        created_at: a.created_at || new Date().toISOString(),
      }))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }
}
