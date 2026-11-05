import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../shared/database/database.service';
import { EventsService } from '../events/events.service';
import { PublishingRepository } from './publishing.repository';
import { ScheduleArtifactProvider } from './providers/schedule-artifact.provider';
import { FormArtifactProvider } from './providers/form-artifact.provider';
import { PublicationContext } from './interfaces/publication-context.interface';
import { ArtifactResult } from './interfaces/artifact-provider.interface';
import { ReleaseManifest } from './interfaces/release-manifest.interface';
import { ReleaseEntity, ReleaseArtifactEntity } from './models/release.entity';
import { ReadinessReportDto } from './dto/readiness-report.dto';
import { EventRevisionEntity } from '../events/models/event-revision.entity';
import { EventStatus } from '../events/models/event-status.enum';
import { TenantClaims } from '../shared/auth/tenant-claims.interface';
import { EventsRepository } from '../events/events.repository';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';
import { generateUuidV7 } from '../shared/crypto/uuidv7';
import { computeSha256 } from '../shared/crypto/canonical-json';

@Injectable()
export class ReleaseAssemblerService {
  private readonly logger = new Logger(ReleaseAssemblerService.name);
  private readonly pubRepo: PublishingRepository;

  constructor(
    private readonly databaseService: DatabaseService,
    private readonly eventsService: EventsService,
    publishingRepository?: PublishingRepository,
    private readonly scheduleProvider: ScheduleArtifactProvider = new ScheduleArtifactProvider(),
    private readonly formProvider: FormArtifactProvider = new FormArtifactProvider(),
  ) {
    this.pubRepo =
      publishingRepository ||
      new PublishingRepository(
        databaseService,
        new EventsRepository(databaseService),
      );
  }

  /**
   * EC-030: Comprehensive Readiness Check before assembling/publishing a release.
   * Evaluates event state, dates, permissions, schedule completeness, and forms/consent bindings.
   */
  async validateReadiness(
    context: PublicationContext,
    claims: TenantClaims,
  ): Promise<ReadinessReportDto> {
    const errors: string[] = [];
    const warnings: string[] = [];
    warnings.push('Agenda y formularios usan fixtures de desarrollo; no equivalen a validaciones reales de B/C.');

    // 1. Validate Actor Permissions
    if (!claims.scopes.includes('events:publish')) {
      errors.push("Actor does not possess the required 'events:publish' scope.");
    }

    // 2. Validate Event Existence and Status
    const event = await this.eventsService.getEventById(claims, context.event_id);

    if (event.revision_number !== context.expected_event_revision) {
      errors.push(
        `Precondition Failed: event revision mismatch (current: ${event.revision_number}, expected: ${context.expected_event_revision}).`,
      );
    }

    if (event.status === EventStatus.CANCELLED) {
      errors.push(`Cannot publish event '${context.event_id}': event has been cancelled.`);
    }

    if (event.status === EventStatus.ARCHIVED) {
      errors.push(`Cannot publish event '${context.event_id}': event is in a terminal archived state.`);
    }

    // 3. Date consistency
    const startsAt = new Date(event.starts_at);
    const endsAt = new Date(event.ends_at);
    if (isNaN(startsAt.getTime()) || isNaN(endsAt.getTime()) || startsAt >= endsAt) {
      errors.push('Event start date (starts_at) must be strictly earlier than end date (ends_at).');
    }

    // 4. Site presence
    if (!event.site_id) {
      errors.push('Event must be associated with a valid site_id.');
    }

    // 5. Schedule Readiness (Integrante B)
    const scheduleValidation = await this.scheduleProvider.validateSchedule(context);
    errors.push(...scheduleValidation.errors);
    warnings.push(...scheduleValidation.warnings);

    // 6. Forms & Consent Readiness (Integrante C)
    const formsValidation = await this.formProvider.validateBindings(context);
    errors.push(...formsValidation.errors);
    warnings.push(...formsValidation.warnings);

    return {
      is_ready: errors.length === 0,
      event_id: context.event_id,
      organization_id: context.organization_id,
      expected_revision: context.expected_event_revision,
      errors,
      warnings,
      checked_at: new Date().toISOString(),
    };
  }

  /**
   * Assembles a ReleaseManifest in-memory from domain artifacts using RFC 8785 canonical hashes.
   */
  async assembleRelease(
    context: PublicationContext,
    actorId: string,
  ): Promise<ReleaseManifest> {
    // 1. Read validated snapshot from Integrante A (Events)
    const eventSnapshotResult = await this.eventsService.readEventSnapshot(
      context.organization_id,
      context.event_id,
      context.expected_event_revision,
    );

    const eventArtifact: ArtifactResult = {
      kind: 'event',
      version: `rev-${eventSnapshotResult.snapshot.revision_number}`,
      body: eventSnapshotResult.snapshot as unknown as Record<string, unknown>,
      hash: eventSnapshotResult.hash,
      errors: [],
      warnings: [],
    };

    // 2. Obtain Schedule artifact (Integrante B)
    const scheduleArtifact = await this.scheduleProvider.buildScheduleArtifact(context);

    // 3. Obtain Forms artifact (Integrante C)
    const formArtifact = await this.formProvider.buildFormArtifact(context);

    // 4. Validate readiness and blocking errors
    const allErrors = [
      ...eventArtifact.errors,
      ...scheduleArtifact.errors,
      ...formArtifact.errors,
    ];

    if (allErrors.length > 0) {
      throw ProblemDetailsException.unprocessable(
        'Release validation failed with blocking errors across domain artifacts.',
        allErrors.map((err, idx) => ({ name: `artifact_error_${idx + 1}`, reason: err })),
        'READINESS_CHECK_FAILED',
      );
    }

    // 5. Generate publication identity & hashes
    const publicationId = generateUuidV7();
    const manifestRef = `/configuration/v1/events/${context.event_id}/releases/${publicationId}/manifest`;
    const nextReleaseVersion = await this.pubRepo.getNextReleaseVersion(
      context.organization_id,
      context.event_id,
      context.transaction,
    );

    const manifestPayload: Omit<ReleaseManifest, 'manifest_hash'> = {
      validation_mode: 'development_fixture',
      organization_id: context.organization_id,
      business_event_id: context.event_id,
      publication_id: publicationId,
      release_version: nextReleaseVersion,
      effective_at: context.effective_at,
      manifest_ref: manifestRef,
      artifacts: {
        event: {
          kind: 'event',
          version: eventArtifact.version,
          ref: `${manifestRef}/artifacts/event`,
          sha256: eventArtifact.hash,
        },
        schedule: {
          kind: 'schedule',
          version: scheduleArtifact.version,
          ref: `${manifestRef}/artifacts/schedule`,
          sha256: scheduleArtifact.hash,
        },
        forms: {
          kind: 'forms',
          version: formArtifact.version,
          ref: `${manifestRef}/artifacts/forms`,
          sha256: formArtifact.hash,
        },
      },
    };

    // RFC 8785 canonical hash of manifest
    const manifestHash = computeSha256(manifestPayload);
    const completeManifest: ReleaseManifest = {
      ...manifestPayload,
      manifest_hash: manifestHash,
    };

    this.logger.log(`Assembled Release Manifest: ${publicationId} with hash ${manifestHash}`);
    return completeManifest;
  }

  /**
   * EC-031: Atomic Release Publication.
   * Runs Readiness check, reads artifacts under SERIALIZABLE transaction,
   * computes RFC 8785 hashes, and persists release, release_artifacts, outbox CloudEvent,
   * and updated event revision in a single commit.
   */
  async publishRelease(
    context: PublicationContext,
    claims: TenantClaims,
    idempotencyKey?: string,
  ): Promise<ReleaseEntity> {
    if (this.databaseService.getIsConnected() && !context.transaction) {
      return this.databaseService.withSerializableTransaction(context.organization_id, (trx) =>
        this.publishRelease({ ...context, transaction: trx }, claims, idempotencyKey),
      );
    }
    const currentEvent = await this.eventsService.getEventById(claims, context.event_id);
    if (currentEvent.revision_number !== context.expected_event_revision) {
      throw ProblemDetailsException.preconditionFailed(
        `Event revision is ${currentEvent.revision_number}; expected ${context.expected_event_revision}.`,
        'REVISION_MISMATCH',
      );
    }
    const targetStatus = context.target_status ||
      (currentEvent.status === EventStatus.CLOSED ? EventStatus.CLOSED : EventStatus.PUBLISHED);
    context = { ...context, target_status: targetStatus };
    // 1. Readiness Check (EC-030) - Must succeed before any database write
    const readiness = await this.validateReadiness(context, claims);
    if (!readiness.is_ready) {
      throw ProblemDetailsException.unprocessable(
        'Release readiness check failed with blocking errors across domain artifacts.',
        readiness.errors.map((err, idx) => ({ name: `blocking_error_${idx + 1}`, reason: err })),
        'READINESS_CHECK_FAILED',
      );
    }

    // 2. Read snapshot & artifacts
    const eventSnapshotResult = await this.eventsService.readEventSnapshot(
      context.organization_id,
      context.event_id,
      context.expected_event_revision,
    );

    const scheduleArtifact = await this.scheduleProvider.buildScheduleArtifact(context);
    const formArtifact = await this.formProvider.buildFormArtifact(context);

    // 3. Monotonic version & publication ID
    const releaseVersion = await this.pubRepo.getNextReleaseVersion(
      context.organization_id,
      context.event_id,
      context.transaction,
    );
    const publicationId = generateUuidV7();
    const manifestRef = `/configuration/v1/events/${context.event_id}/releases/${publicationId}/manifest`;
    const nowIso = new Date().toISOString();

    const eventArtifactRef = `${manifestRef}/artifacts/event`;
    const scheduleArtifactRef = `${manifestRef}/artifacts/schedule`;
    const formsArtifactRef = `${manifestRef}/artifacts/forms`;

    const manifestPayload: Omit<ReleaseManifest, 'manifest_hash'> = {
      validation_mode: 'development_fixture',
      organization_id: context.organization_id,
      business_event_id: context.event_id,
      publication_id: publicationId,
      release_version: releaseVersion,
      effective_at: context.effective_at,
      manifest_ref: manifestRef,
      artifacts: {
        event: {
          kind: 'event',
          version: `rev-${eventSnapshotResult.snapshot.revision_number}`,
          ref: eventArtifactRef,
          sha256: eventSnapshotResult.hash,
        },
        schedule: {
          kind: 'schedule',
          version: scheduleArtifact.version,
          ref: scheduleArtifactRef,
          sha256: scheduleArtifact.hash,
        },
        forms: {
          kind: 'forms',
          version: formArtifact.version,
          ref: formsArtifactRef,
          sha256: formArtifact.hash,
        },
      },
    };

    const manifestHash = computeSha256(manifestPayload);
    const completeManifest: ReleaseManifest = {
      ...manifestPayload,
      manifest_hash: manifestHash,
    };

    // 4. Prepare release entity
    const release: ReleaseEntity = {
      id: publicationId,
      organization_id: context.organization_id,
      event_id: context.event_id,
      release_version: releaseVersion,
      effective_at: context.effective_at,
      manifest_ref: manifestRef,
      manifest_hash: manifestHash,
      manifest: completeManifest,
      event_revision_number: context.expected_event_revision + 1,
      status: 'published',
      created_by: claims.sub,
      created_at: nowIso,
    };

    // 5. Prepare artifacts entities
    const artifacts: ReleaseArtifactEntity[] = [
      {
        id: generateUuidV7(),
        organization_id: context.organization_id,
        release_id: publicationId,
        event_id: context.event_id,
        kind: 'event',
        version: `rev-${eventSnapshotResult.snapshot.revision_number}`,
        artifact_ref: eventArtifactRef,
        sha256: eventSnapshotResult.hash,
        body: eventSnapshotResult.snapshot as unknown as Record<string, unknown>,
        created_at: nowIso,
      },
      {
        id: generateUuidV7(),
        organization_id: context.organization_id,
        release_id: publicationId,
        event_id: context.event_id,
        kind: 'schedule',
        version: scheduleArtifact.version,
        artifact_ref: scheduleArtifactRef,
        sha256: scheduleArtifact.hash,
        body: scheduleArtifact.body,
        created_at: nowIso,
      },
      {
        id: generateUuidV7(),
        organization_id: context.organization_id,
        release_id: publicationId,
        event_id: context.event_id,
        kind: 'forms',
        version: formArtifact.version,
        artifact_ref: formsArtifactRef,
        sha256: formArtifact.hash,
        body: formArtifact.body,
        created_at: nowIso,
      },
    ];

    // Pending relay message; consumers use the canonical envelope from contracts/EVENT-CONTRACTS.md.
    const messageId = generateUuidV7();
    const outboxPayload = {
      message_id: messageId,
      domain_event_id: messageId,
      topic: 'configuration.event.release_published.v1',
      schema_version: 1,
      producer: 'configuration',
      organization_id: context.organization_id,
      business_event_id: context.event_id,
      occurred_at: nowIso,
      published_at: nowIso,
      actor: { type: 'user', id: claims.sub },
      traceparent: null,
      correlation_id: claims.request_id || messageId,
      causation_id: claims.request_id || null,
      aggregate: { type: 'release', id: publicationId, version: releaseVersion },
      partition_key: `${context.organization_id}:${context.event_id}`,
      data: {
        publication_id: publicationId,
        release_version: releaseVersion,
        manifest_ref: manifestRef,
        manifest_hash: manifestHash,
        effective_at: context.effective_at,
      },
    };

    const outboxEntry = {
      id: generateUuidV7(),
      organization_id: context.organization_id,
      event_type: 'configuration.event.release_published.v1',
      aggregate_type: 'release',
      aggregate_id: publicationId,
      payload: outboxPayload,
      headers: {
        'idempotency-key': idempotencyKey || null,
        'manifest-ref': manifestRef,
        'manifest-hash': manifestHash,
      },
      status: 'pending' as const,
    };

    // 7. Event progression & revision evolution
    const nextRevisionNumber = context.expected_event_revision + 1;
    const newRevisionId = generateUuidV7();

    const newSnapshot: Record<string, unknown> = {
      ...eventSnapshotResult.snapshot,
      status: targetStatus,
      revision_number: nextRevisionNumber,
      updated_at: nowIso,
    };

    const newRevision: EventRevisionEntity = {
      id: newRevisionId,
      organization_id: context.organization_id,
      event_id: context.event_id,
      revision_number: nextRevisionNumber,
      snapshot: newSnapshot,
      change_summary: `Published Release v${releaseVersion} (Publication ID ${publicationId}).`,
      created_by: claims.sub,
      created_at: nowIso,
    };

    // 8. Append-only audit record
    const auditEntry = {
      organization_id: context.organization_id,
      entity_type: 'release',
      entity_id: publicationId,
      action: 'PUBLISH_RELEASE',
      actor_id: claims.sub,
      actor_roles: claims.roles,
      request_id: claims.request_id,
      idempotency_key: idempotencyKey,
      revision_number: nextRevisionNumber,
      diff: {
        publication_id: publicationId,
        release_version: releaseVersion,
        manifest_hash: manifestHash,
        manifest_ref: manifestRef,
      },
      payload_hash: manifestHash,
      client_ip: claims.client_ip,
      user_agent: claims.user_agent,
    };

    // 9. Atomic persistence in SERIALIZABLE transaction
    const savedRelease = await this.pubRepo.saveAtomicRelease(
      context.organization_id,
      release,
      artifacts,
      outboxEntry,
      auditEntry,
      {
      status: targetStatus,
      },
      newRevision,
      context.expected_event_revision,
    );

    this.logger.log(
      `Successfully published release v${releaseVersion} (${publicationId}) with manifest hash ${manifestHash} for event ${context.event_id}`,
    );

    return savedRelease;
  }

  async listReleases(organizationId: string, eventId: string): Promise<ReleaseEntity[]> {
    return await this.pubRepo.listReleasesByEvent(organizationId, eventId);
  }

  async recordCancellationRelease(
    claims: TenantClaims,
    cancelledEvent: { id: string; revision_number: number },
    publicationId: string,
    effectiveAt = new Date().toISOString(),
  ): Promise<ReleaseEntity> {
    const organizationId = claims.organization_id;
    const eventId = cancelledEvent.id;
    const version = await this.pubRepo.getNextReleaseVersion(organizationId, eventId);
    const now = new Date().toISOString();
    const manifestRef = `/configuration/v1/events/${eventId}/releases/${publicationId}/manifest`;
    const context: PublicationContext = {
      organization_id: organizationId,
      event_id: eventId,
      expected_event_revision: cancelledEvent.revision_number,
      effective_at: effectiveAt,
      target_status: EventStatus.CANCELLED,
    };
    const eventSnapshot = await this.eventsService.readEventSnapshot(organizationId, eventId, cancelledEvent.revision_number);
    const schedule = await this.scheduleProvider.buildScheduleArtifact(context);
    const forms = await this.formProvider.buildFormArtifact(context);
    const artifactInputs = [
      { kind: 'event' as const, version: `rev-${cancelledEvent.revision_number}`, body: eventSnapshot.snapshot as unknown as Record<string, unknown>, hash: eventSnapshot.hash },
      { kind: 'schedule' as const, version: schedule.version, body: schedule.body, hash: schedule.hash },
      { kind: 'forms' as const, version: forms.version, body: forms.body, hash: forms.hash },
    ];
    const artifacts = artifactInputs.map((item): ReleaseArtifactEntity => ({
      id: generateUuidV7(), organization_id: organizationId, release_id: publicationId,
      event_id: eventId, kind: item.kind, version: item.version,
      artifact_ref: `${manifestRef}/artifacts/${item.kind}`, sha256: item.hash,
      body: item.body, created_at: now,
    }));
    const refs = Object.fromEntries(artifacts.map((item) => [item.kind, {
      kind: item.kind, version: item.version, ref: item.artifact_ref, sha256: item.sha256,
    }]));
    const payload = {
      validation_mode: 'development_fixture' as const,
      organization_id: organizationId, business_event_id: eventId, publication_id: publicationId,
      release_version: version, effective_at: effectiveAt, manifest_ref: manifestRef,
      artifacts: refs as ReleaseManifest['artifacts'],
    };
    const manifest: ReleaseManifest = { ...payload, manifest_hash: computeSha256(payload) };
    const release: ReleaseEntity = {
      id: publicationId, organization_id: organizationId, event_id: eventId,
      release_version: version, effective_at: effectiveAt, manifest_ref: manifestRef,
      manifest_hash: manifest.manifest_hash, manifest,
      event_revision_number: cancelledEvent.revision_number, status: 'cancelled',
      created_by: claims.sub, created_at: now,
    };
    await this.pubRepo.saveCancellationRelease(organizationId, release, artifacts);
    return release;
  }

  async getReleaseById(organizationId: string, releaseId: string): Promise<ReleaseEntity> {
    const release = await this.pubRepo.findReleaseById(organizationId, releaseId);
    if (!release) {
      throw ProblemDetailsException.notFound(
        `Release '${releaseId}' was not found.`,
        'RELEASE_NOT_FOUND',
      );
    }
    return release;
  }

  async getReleaseArtifacts(organizationId: string, releaseId: string): Promise<ReleaseArtifactEntity[]> {
    return await this.pubRepo.getReleaseArtifacts(organizationId, releaseId);
  }
}
