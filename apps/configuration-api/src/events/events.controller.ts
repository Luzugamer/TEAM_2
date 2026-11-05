import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  Query,
  Param,
  Headers,
  Req,
  Res,
  HttpStatus,
  UseGuards,
  ValidationPipe,
  UsePipes,
  Inject,
  Optional,
  forwardRef,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { DuplicateEventDto } from './dto/duplicate-event.dto';
import { CancelEventDto } from './dto/cancel-event.dto';
import { CloseEventDto } from './dto/close-event.dto';
import { ListEventsQueryDto } from './dto/list-events-query.dto';
import { EventResponseDto, EventListResponseDto } from './dto/event-response.dto';
import { EventStatus } from './models/event-status.enum';
import { generateUuidV7 } from '../shared/crypto/uuidv7';
import { CreateAssignmentDto } from './dto/create-assignment.dto';
import { AssignmentResponseDto } from './dto/assignment-response.dto';
import { AuditResponseDto } from './dto/audit-response.dto';
import { EventHistoryResponseDto } from './dto/event-history-response.dto';
import { CreateReleaseDto } from '../publishing/dto/create-release.dto';
import { ReadinessReportDto } from '../publishing/dto/readiness-report.dto';
import { ValidatePublicationDto } from './dto/validate-publication.dto';
import { ReleaseEntity } from '../publishing/models/release.entity';
import { ReleaseManifest } from '../publishing/interfaces/release-manifest.interface';
import { ReleaseAssemblerService } from '../publishing/release-assembler.service';
import { AuthGuard } from '../shared/auth/auth.guard';
import { Claims } from '../shared/auth/claims.decorator';
import { RequireScopes } from '../shared/auth/scopes.decorator';
import { TenantClaims } from '../shared/auth/tenant-claims.interface';
import { CachedResponse, IdempotencyService } from '../shared/idempotency/idempotency.service';
import { ProblemDetailsException } from '../shared/errors/problem-details.exception';
import { ApiSecurity } from '@nestjs/swagger';

@Controller('events')
@UseGuards(AuthGuard)
@ApiSecurity('DevActor')
export class EventsController {
  constructor(
    private readonly eventsService: EventsService,
    private readonly idempotencyService: IdempotencyService,
    @Optional()
    @Inject(forwardRef(() => ReleaseAssemblerService))
    private readonly releaseAssembler?: ReleaseAssemblerService,
  ) {}

  private async respondOnce(
    claims: TenantClaims,
    key: string,
    requestPath: string,
    operation: string,
    payload: unknown,
    command: () => Promise<CachedResponse>,
    res: Response,
  ): Promise<void> {
    const response = await this.idempotencyService.executeOnce(
      claims.organization_id, claims.sub, operation, key, requestPath, payload, command,
    );
    for (const [name, value] of Object.entries(response.headers)) res.setHeader(name, value);
    res.status(response.statusCode).json(response.body);
  }

  @Post()
  @RequireScopes('events:write')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async createEvent(
    @Claims() claims: TenantClaims,
    @Body() dto: CreateEventDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for command POST operation.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'create', dto, async () => {
      const result = await this.eventsService.createEvent(claims, dto, idempotencyKey);
      return { statusCode: HttpStatus.CREATED, headers: { ETag: `"${result.revision_number}"`, 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  @Get()
  @RequireScopes('events:write', 'events:read')
  @UsePipes(new ValidationPipe({ transform: true }))
  async listEvents(
    @Claims() claims: TenantClaims,
    @Query() query: ListEventsQueryDto,
  ): Promise<EventListResponseDto> {
    return await this.eventsService.listEvents(claims, query);
  }

  @Get(':id')
  @RequireScopes('events:write', 'events:read')
  async getEventById(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const event = await this.eventsService.getEventById(claims, id);
    res.setHeader('ETag', `"${event.revision_number}"`);
    res.status(HttpStatus.OK).json(event);
  }

  @Patch(':id')
  @RequireScopes('events:write')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async updateEvent(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Body() dto: UpdateEventDto,
    @Res() res: Response,
  ): Promise<void> {
    if (!ifMatchHeader || ifMatchHeader.trim() === '') {
      throw ProblemDetailsException.preconditionRequired(
        "Header 'If-Match' is required for optimistic concurrency control on event modification.",
      );
    }

    const cleaned = ifMatchHeader.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    const expectedRevision = parseInt(cleaned, 10);
    if (isNaN(expectedRevision) || expectedRevision < 1) {
      throw ProblemDetailsException.badRequest(
        `Invalid 'If-Match' header value '${ifMatchHeader}'. Must be a valid positive revision integer or quoted ETag (e.g. "1").`,
        [{ name: 'If-Match', reason: 'Must be a valid revision number' }],
      );
    }

    const updated = await this.eventsService.updateEvent(claims, id, expectedRevision, dto);
    res.setHeader('ETag', `"${updated.revision_number}"`);
    res.status(HttpStatus.OK).json(updated);
  }

  @Post(':id/duplications')
  @RequireScopes('events:write')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async duplicateEvent(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Body() dto: DuplicateEventDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for duplicate command operation.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'duplicate', dto, async () => {
      const result = await this.eventsService.duplicateEvent(claims, id, dto, idempotencyKey);
      return { statusCode: HttpStatus.CREATED, headers: { ETag: `"${result.revision_number}"`, 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  private parseIfMatch(header: string | undefined): number {
    if (!header || header.trim() === '') {
      throw ProblemDetailsException.preconditionRequired(
        "Header 'If-Match' is required for optimistic concurrency control on this transition.",
      );
    }
    const cleaned = header.trim().replace(/^W\//, '').replace(/^"|"$/g, '');
    const revision = parseInt(cleaned, 10);
    if (isNaN(revision) || revision < 1) {
      throw ProblemDetailsException.badRequest(
        `Invalid 'If-Match' header value '${header}'. Must be a valid positive integer or quoted ETag (e.g. "1").`,
        [{ name: 'If-Match', reason: 'Must be a valid revision number' }],
      );
    }
    return revision;
  }

  @Post(':id/closures')
  @RequireScopes('events:publish')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async closeEvent(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CloseEventDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for close command operation.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const expectedRevision = this.parseIfMatch(ifMatchHeader);
    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'close', { ...dto, expectedRevision }, async () => {
      if (!this.releaseAssembler) throw new Error('ReleaseAssemblerService is not configured');
      const closed = await this.eventsService.closeEvent(claims, id, expectedRevision, dto, idempotencyKey);
      await this.releaseAssembler.publishRelease({
        organization_id: claims.organization_id,
        event_id: id,
        expected_event_revision: closed.revision_number,
        effective_at: dto.effective_at,
        target_status: EventStatus.CLOSED,
      }, claims, idempotencyKey);
      const result = await this.eventsService.getEventById(claims, id);
      return { statusCode: HttpStatus.OK, headers: { ETag: `"${result.revision_number}"`, 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  @Post(':id/cancellations')
  @RequireScopes('events:publish')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async cancelEvent(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CancelEventDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for cancel command operation.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const expectedRevision = this.parseIfMatch(ifMatchHeader);
    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'cancel', { ...dto, expectedRevision }, async () => {
      if (!this.releaseAssembler) throw new Error('ReleaseAssemblerService is not configured');
      const cancellationReleaseId = generateUuidV7();
      const result = await this.eventsService.cancelEvent(claims, id, expectedRevision, dto, idempotencyKey, cancellationReleaseId);
      await this.releaseAssembler.recordCancellationRelease(claims, result, cancellationReleaseId, dto.effective_at);
      return { statusCode: HttpStatus.OK, headers: { ETag: `"${result.revision_number}"`, 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  @Post(':id/archives')
  @RequireScopes('events:write')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async archiveEvent(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for archive command operation.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const expectedRevision = this.parseIfMatch(ifMatchHeader);
    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'archive', { expectedRevision }, async () => {
      const result = await this.eventsService.archiveEvent(claims, id, expectedRevision, {}, idempotencyKey);
      return { statusCode: HttpStatus.OK, headers: { ETag: `"${result.revision_number}"`, 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  @Get(':id/revisions')
  @RequireScopes('events:write', 'events:read')
  async getRevisions(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
  ) {
    return await this.eventsService.getRevisions(claims, id);
  }

  @Post(':id/assignments')
  @RequireScopes('events:write')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async createAssignment(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateAssignmentDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for assignment command operation.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'assign', dto, async () => {
      const result = await this.eventsService.createAssignment(claims, id, dto, idempotencyKey);
      return { statusCode: HttpStatus.CREATED, headers: { 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  @Get(':id/assignments')
  @RequireScopes('events:write', 'events:read')
  async listAssignments(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
  ): Promise<AssignmentResponseDto[]> {
    return await this.eventsService.listAssignments(claims, id);
  }

  @Delete(':id/assignments/:assignment_id')
  @RequireScopes('events:write')
  async revokeAssignment(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Param('assignment_id') assignmentId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for assignment revocation operation.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'revoke-assignment', { assignmentId, action: 'REVOKE' }, async () => {
      const result = await this.eventsService.revokeAssignment(claims, id, assignmentId, idempotencyKey);
      return { statusCode: HttpStatus.OK, headers: { 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  @Post(':id/publication-validations')
  @RequireScopes('events:publish')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async validatePublication(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Body() dto: ValidatePublicationDto,
  ): Promise<ReadinessReportDto> {
    if (!this.releaseAssembler) {
      throw new Error('ReleaseAssemblerService is not configured');
    }

    return await this.releaseAssembler.validateReadiness(
      {
        organization_id: claims.organization_id,
        event_id: id,
        expected_event_revision: dto.expected_event_revision,
        effective_at: new Date().toISOString(),
      },
      claims,
    );
  }

  @Post(':id/releases')
  @RequireScopes('events:publish')
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  async createRelease(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Headers('if-match') ifMatchHeader: string | undefined,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() dto: CreateReleaseDto,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    if (!idempotencyKey || idempotencyKey.trim() === '') {
      throw ProblemDetailsException.badRequest(
        'Missing mandatory Idempotency-Key header for release creation command.',
        [{ name: 'Idempotency-Key', reason: 'Header is required' }],
      );
    }

    const expectedRevision = this.parseIfMatch(ifMatchHeader);
    if (expectedRevision !== dto.expected_event_revision) {
      throw ProblemDetailsException.preconditionFailed(
        'If-Match and expected_event_revision must identify the same event revision.',
        'stale_revision',
      );
    }
    const requestPath = req.originalUrl || req.url;
    await this.respondOnce(claims, idempotencyKey, requestPath, 'release', { ...dto, expectedRevision }, async () => {
      if (!this.releaseAssembler) throw new Error('ReleaseAssemblerService is not configured');
      const result = await this.releaseAssembler.publishRelease({
        organization_id: claims.organization_id,
        event_id: id,
        expected_event_revision: expectedRevision,
        effective_at: dto.effective_at || new Date().toISOString(),
      }, claims, idempotencyKey);
      return { statusCode: HttpStatus.CREATED, headers: { ETag: `"${result.event_revision_number}"`, 'Content-Type': 'application/json' }, body: result };
    }, res);
  }

  @Get(':id/releases')
  @RequireScopes('events:write', 'events:read')
  async listReleases(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
  ): Promise<ReleaseEntity[]> {
    if (!this.releaseAssembler) {
      throw new Error('ReleaseAssemblerService is not configured');
    }
    await this.eventsService.getEventById(claims, id);
    return await this.releaseAssembler.listReleases(claims.organization_id, id);
  }

  @Get(':id/releases/:release_id')
  @RequireScopes('events:write', 'events:read')
  async getReleaseById(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Param('release_id') releaseId: string,
  ): Promise<ReleaseEntity> {
    if (!this.releaseAssembler) {
      throw new Error('ReleaseAssemblerService is not configured');
    }
    await this.eventsService.getEventById(claims, id);
    const release = await this.releaseAssembler.getReleaseById(claims.organization_id, releaseId);
    if (release.event_id !== id) throw ProblemDetailsException.notFound('Release not found for event.', 'RELEASE_NOT_FOUND');
    return release;
  }

  @Get(':id/releases/:release_id/manifest')
  @RequireScopes('events:write', 'events:read')
  async getReleaseManifest(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Param('release_id') releaseId: string,
  ): Promise<ReleaseManifest> {
    const release = await this.getReleaseById(claims, id, releaseId);
    return release.manifest;
  }

  @Get(':id/releases/:release_id/manifest/artifacts/:kind')
  @RequireScopes('events:write', 'events:read')
  async getReleaseArtifact(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
    @Param('release_id') releaseId: string,
    @Param('kind') kind: string,
  ) {
    await this.getReleaseById(claims, id, releaseId);
    const artifacts = await this.releaseAssembler!.getReleaseArtifacts(claims.organization_id, releaseId);
    const artifact = artifacts.find((item) => item.kind === kind);
    if (!artifact) throw ProblemDetailsException.notFound('Release artifact not found.', 'ARTIFACT_NOT_FOUND');
    return artifact;
  }

  @Get(':id/audit')
  @RequireScopes('events:read', 'events:write')
  async getAuditTrail(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
  ): Promise<AuditResponseDto[]> {
    return await this.eventsService.getAuditTrail(claims, id);
  }

  @Get(':id/history')
  @RequireScopes('events:read', 'events:write')
  async getEventHistory(
    @Claims() claims: TenantClaims,
    @Param('id') id: string,
  ): Promise<EventHistoryResponseDto> {
    return await this.eventsService.getEventHistory(claims, id);
  }
}

