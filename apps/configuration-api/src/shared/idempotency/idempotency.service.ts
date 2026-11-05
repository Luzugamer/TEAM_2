import { Injectable } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../database/database.service';
import { computeSha256 } from '../crypto/canonical-json';
import { ProblemDetailsException } from '../errors/problem-details.exception';

export interface CachedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: unknown;
}

@Injectable()
export class IdempotencyService {
  // In-memory fallback map for test environments without live DB
  private memoryCache = new Map<string, { requestHash: string; response: CachedResponse }>();

  constructor(private readonly databaseService: DatabaseService) {}

  async executeOnce(
    organizationId: string,
    actorId: string,
    operation: string,
    key: string,
    requestPath: string,
    body: unknown,
    command: () => Promise<CachedResponse>,
  ): Promise<CachedResponse> {
    const requestHash = computeSha256({ requestPath, body: body ?? {} });
    const cacheKey = `${organizationId}:${actorId}:${operation}:${key}`;
    const conflict = () => ProblemDetailsException.idempotencyConflict(
      `Idempotency-Key '${key}' was already processed with a different request payload.`,
    );

    if (!this.databaseService.getIsConnected()) {
      const prior = this.memoryCache.get(cacheKey);
      if (prior) {
        if (prior.requestHash !== requestHash) throw conflict();
        return prior.response;
      }
      const response = await command();
      this.memoryCache.set(cacheKey, { requestHash, response });
      return response;
    }

    return this.databaseService.withSerializableTransaction(organizationId, async (db) => {
      await sql`SELECT pg_advisory_xact_lock(hashtextextended(${cacheKey}, 0))`.execute(db);
      const prior = await db.selectFrom('idempotency_records').selectAll()
        .where('organization_id', '=', organizationId)
        .where('actor_id', '=', actorId)
        .where('operation', '=', operation)
        .where('idempotency_key', '=', key)
        .executeTakeFirst();
      if (prior) {
        if (prior.request_hash !== requestHash) throw conflict();
        return {
          statusCode: prior.response_code,
          headers: prior.response_headers as Record<string, string>,
          body: prior.response_body,
        };
      }
      const response = await command();
      await db.insertInto('idempotency_records').values({
        organization_id: organizationId,
        actor_id: actorId,
        operation,
        idempotency_key: key,
        request_path: requestPath,
        request_hash: requestHash,
        response_code: response.statusCode,
        response_headers: response.headers,
        response_body: response.body as Record<string, unknown>,
      }).execute();
      return response;
    });
  }
}

