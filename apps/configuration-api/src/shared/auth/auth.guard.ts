import { Injectable, CanActivate, ExecutionContext, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SCOPES_KEY } from './scopes.decorator';
import { TenantClaims } from './tenant-claims.interface';
import { ProblemDetailsException } from '../errors/problem-details.exception';

// Replace this provider with verified OIDC claims when Platform Foundation is ready.
export interface ClaimsProvider {
  resolve(actorId: string | undefined, request: any): TenantClaims;
}
export const CLAIMS_PROVIDER = 'CLAIMS_PROVIDER';

const actors: Record<string, Pick<TenantClaims, 'sub' | 'organization_id' | 'roles' | 'scopes'>> = {
  'org-a-manager': {
    sub: '0194eb00-0000-7000-9000-000000000001',
    organization_id: '0194eb00-0000-7000-8000-000000000001',
    roles: ['event_manager'],
    scopes: ['events:write', 'events:publish', 'events:read'],
  },
  'org-a-reader': {
    sub: '0194eb00-0000-7000-9000-000000000002',
    organization_id: '0194eb00-0000-7000-8000-000000000001',
    roles: ['report_viewer'],
    scopes: ['events:read'],
  },
  'org-b-manager': {
    sub: '0194eb00-0000-7000-9000-000000000010',
    organization_id: '0194eb00-0000-7000-8000-000000000002',
    roles: ['event_manager'],
    scopes: ['events:write', 'events:publish', 'events:read'],
  },
};

@Injectable()
export class MockClaimsProvider implements ClaimsProvider {
  resolve(actorId: string | undefined, request: any): TenantClaims {
    const actor = actorId ? actors[actorId] : undefined;
    if (!actor) {
      throw ProblemDetailsException.unauthorized('Unknown development actor.');
    }
    return {
      ...actor,
      request_id: request.headers['x-request-id'] as string | undefined,
      client_ip: request.ip,
      user_agent: request.headers['user-agent'] as string | undefined,
    };
  }
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, @Inject(CLAIMS_PROVIDER) private readonly claimsProvider: ClaimsProvider) {}

  canActivate(context: ExecutionContext): boolean {
    if (process.env.AUTH_MODE !== 'mock' || process.env.NODE_ENV !== 'development') {
      throw ProblemDetailsException.unauthorized('A verified identity provider is not configured.');
    }
    const request = context.switchToHttp().getRequest();
    const actorHeader = request.headers['x-dev-actor'];
    const claims = this.claimsProvider.resolve(typeof actorHeader === 'string' ? actorHeader : undefined, request);
    const requiredScopes = this.reflector.getAllAndOverride<string[]>(SCOPES_KEY, [context.getHandler(), context.getClass()]);
    if (requiredScopes?.length && !requiredScopes.some((scope) => claims.scopes.includes(scope))) {
      throw ProblemDetailsException.forbidden('Insufficient permissions.');
    }
    request.user = claims;
    return true;
  }
}
