import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../shared/database/database.service';
import { EventsRepository, AuditRecordInput, OutboxRecordInput } from '../events/events.repository';
import { ReleaseEntity, ReleaseArtifactEntity } from './models/release.entity';
import { EventRevisionEntity } from '../events/models/event-revision.entity';
import { EventEntity } from '../events/models/event.entity';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';
import { sql, Kysely } from 'kysely';
import { DatabaseSchema } from '../shared/database/types';
import { generateUuidV7 } from '../shared/crypto/uuidv7';

@Injectable()
export class PublishingRepository {
  private readonly logger = new Logger(PublishingRepository.name);

  // In-memory fallback stores for test environments
  private readonly releasesStore = new Map<string, ReleaseEntity>();
  private readonly artifactsStore = new Map<string, ReleaseArtifactEntity[]>();

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly eventsRepository: EventsRepository,
  ) {}

  async getNextReleaseVersion(
    organizationId: string,
    eventId: string,
    trx?: Kysely<DatabaseSchema>,
  ): Promise<number> {
    if (this.databaseService.getIsConnected()) {
      const readVersion = async (db: Kysely<DatabaseSchema>) => {
        const result = await db
        .selectFrom('releases')
        .select(sql<number>`COALESCE(MAX(release_version), 0) + 1`.as('next_version'))
        .where('organization_id', '=', organizationId)
        .where('event_id', '=', eventId)
        .executeTakeFirst();

        return Number(result?.next_version || 1);
      };
      return trx ? readVersion(trx) : this.databaseService.withTenantTransaction(organizationId, readVersion);
    }

    const eventReleases = Array.from(this.releasesStore.values()).filter(
      (r) => r.organization_id === organizationId && r.event_id === eventId,
    );
    if (eventReleases.length === 0) return 1;
    const maxVer = Math.max(...eventReleases.map((r) => r.release_version));
    return maxVer + 1;
  }

  async saveAtomicRelease(
    organizationId: string,
    release: ReleaseEntity,
    artifacts: ReleaseArtifactEntity[],
    outboxEntry: OutboxRecordInput,
    auditEntry: AuditRecordInput,
    updatedEvent: Partial<EventEntity>,
    newEventRevision: EventRevisionEntity,
    expectedRevision: number,
  ): Promise<ReleaseEntity> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withSerializableTransaction(
        organizationId,
        async (trx) => {
          // 1. Advance event state & revision (SERIALIZABLE check on expectedRevision)
          const updatedEventResult = await trx
            .updateTable('events')
            .set({
              status: updatedEvent.status,
              current_revision_id: newEventRevision.id,
              revision_number: newEventRevision.revision_number,
              updated_at: new Date(),
            })
            .where('organization_id', '=', organizationId)
            .where('id', '=', release.event_id)
            .where('revision_number', '=', expectedRevision)
            .returningAll()
            .executeTakeFirst();

          if (!updatedEventResult) {
            throw ProblemDetailsException.preconditionFailed(
              `Precondition Failed: event '${release.event_id}' revision mismatch or concurrent modification during serializable release. Expected revision ${expectedRevision}.`,
              'REVISION_MISMATCH',
            );
          }

          // 2. Insert event revision
          await trx
            .insertInto('event_revisions')
            .values({
              id: newEventRevision.id,
              organization_id: organizationId,
              event_id: release.event_id,
              revision_number: newEventRevision.revision_number,
              snapshot: newEventRevision.snapshot,
              change_summary: newEventRevision.change_summary,
              created_by: newEventRevision.created_by,
              created_at: new Date(newEventRevision.created_at),
            })
            .execute();

          // 3. Insert release manifest
          await trx
            .insertInto('releases')
            .values({
              id: release.id,
              organization_id: release.organization_id,
              event_id: release.event_id,
              release_version: release.release_version,
              effective_at: new Date(release.effective_at),
              manifest_ref: release.manifest_ref,
              manifest_hash: release.manifest_hash,
              manifest: release.manifest as unknown as Record<string, unknown>,
              event_revision_number: release.event_revision_number,
              status: release.status,
              created_by: release.created_by,
              created_at: new Date(release.created_at),
            })
            .execute();

          // 4. Insert release artifacts
          for (const art of artifacts) {
            await trx
              .insertInto('release_artifacts')
              .values({
                id: art.id,
                organization_id: art.organization_id,
                release_id: art.release_id,
                event_id: art.event_id,
                kind: art.kind,
                version: art.version,
                artifact_ref: art.artifact_ref,
                sha256: art.sha256,
                body: art.body,
                created_at: new Date(art.created_at),
              })
              .execute();
          }

          // 5. Insert domain event into Outbox in the SAME atomic commit
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

          // 6. Insert audit record
          await trx
            .insertInto('audit')
            .values({
              organization_id: auditEntry.organization_id,
              entity_type: auditEntry.entity_type,
              entity_id: auditEntry.entity_id,
              action: auditEntry.action,
              actor_id: auditEntry.actor_id,
              actor_roles: auditEntry.actor_roles,
              request_id: auditEntry.request_id || null,
              idempotency_key: auditEntry.idempotency_key || null,
              revision_number: auditEntry.revision_number || null,
              diff: auditEntry.diff || null,
              payload_hash: auditEntry.payload_hash || null,
              client_ip: auditEntry.client_ip || null,
              user_agent: auditEntry.user_agent || null,
              created_at: new Date(),
            })
            .execute();

          return release;
        },
      );
    }

    // In-memory fallback
    // 1. Advance event with revision check
    await this.eventsRepository.updateEventWithRevision(
      organizationId,
      release.event_id,
      expectedRevision,
      updatedEvent,
      newEventRevision,
      auditEntry,
      outboxEntry,
    );

    // 2. Persist release and artifacts in-memory
    this.releasesStore.set(release.id, release);
    this.artifactsStore.set(release.id, artifacts);

    return release;
  }

  async findReleaseById(organizationId: string, releaseId: string): Promise<ReleaseEntity | null> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const row = await db
        .selectFrom('releases')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('id', '=', releaseId)
        .executeTakeFirst();

      if (!row) return null;

      return {
        id: row.id,
        organization_id: row.organization_id,
        event_id: row.event_id,
        release_version: row.release_version,
        effective_at: new Date(row.effective_at).toISOString(),
        manifest_ref: row.manifest_ref,
        manifest_hash: row.manifest_hash,
        manifest: row.manifest as any,
        event_revision_number: row.event_revision_number,
        status: row.status as any,
        created_by: row.created_by,
        created_at: new Date(row.created_at).toISOString(),
      };
          });
    }

    const rel = this.releasesStore.get(releaseId);
    if (!rel || rel.organization_id !== organizationId) return null;
    return rel;
  }

  async saveCancellationRelease(
    organizationId: string,
    release: ReleaseEntity,
    artifacts: ReleaseArtifactEntity[],
  ): Promise<void> {
    if (this.databaseService.getIsConnected()) {
      await this.databaseService.withTenantTransaction(organizationId, async (db) => {
        await db.insertInto('releases').values({
          id: release.id, organization_id: organizationId, event_id: release.event_id,
          release_version: release.release_version, effective_at: new Date(release.effective_at),
          manifest_ref: release.manifest_ref, manifest_hash: release.manifest_hash,
          manifest: release.manifest as unknown as Record<string, unknown>,
          event_revision_number: release.event_revision_number, status: 'cancelled',
          created_by: release.created_by, created_at: new Date(release.created_at),
        }).execute();
        for (const item of artifacts) {
          await db.insertInto('release_artifacts').values({
            id: item.id, organization_id: organizationId, release_id: release.id,
            event_id: release.event_id, kind: item.kind, version: item.version,
            artifact_ref: item.artifact_ref, sha256: item.sha256,
            body: item.body, created_at: new Date(item.created_at),
          }).execute();
        }
      });
    } else {
      this.releasesStore.set(release.id, release);
      this.artifactsStore.set(release.id, artifacts);
    }
  }

  async listReleasesByEvent(organizationId: string, eventId: string): Promise<ReleaseEntity[]> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const rows = await db
        .selectFrom('releases')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('event_id', '=', eventId)
        .orderBy('release_version', 'desc')
        .execute();

      return rows.map((row) => ({
        id: row.id,
        organization_id: row.organization_id,
        event_id: row.event_id,
        release_version: row.release_version,
        effective_at: new Date(row.effective_at).toISOString(),
        manifest_ref: row.manifest_ref,
        manifest_hash: row.manifest_hash,
        manifest: row.manifest as any,
        event_revision_number: row.event_revision_number,
        status: row.status as any,
        created_by: row.created_by,
        created_at: new Date(row.created_at).toISOString(),
      }));
          });
    }

    return Array.from(this.releasesStore.values())
      .filter((r) => r.organization_id === organizationId && r.event_id === eventId)
      .sort((a, b) => b.release_version - a.release_version);
  }

  async getReleaseArtifacts(organizationId: string, releaseId: string): Promise<ReleaseArtifactEntity[]> {
    if (this.databaseService.getIsConnected()) {
      return await this.databaseService.withTenantTransaction(organizationId, async (db) => {
      const rows = await db
        .selectFrom('release_artifacts')
        .selectAll()
        .where('organization_id', '=', organizationId)
        .where('release_id', '=', releaseId)
        .execute();

      return rows.map((row) => ({
        id: row.id,
        organization_id: row.organization_id,
        release_id: row.release_id,
        event_id: row.event_id,
        kind: row.kind as any,
        version: row.version,
        artifact_ref: row.artifact_ref,
        sha256: row.sha256,
        body: row.body as any,
        created_at: new Date(row.created_at).toISOString(),
      }));
          });
    }

    const arts = this.artifactsStore.get(releaseId) || [];
    return arts.filter((a) => a.organization_id === organizationId);
  }
}

