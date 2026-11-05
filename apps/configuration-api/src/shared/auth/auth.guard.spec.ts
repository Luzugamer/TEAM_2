import { afterEach, describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { AuthGuard, MockClaimsProvider } from './auth.guard';
import { ProblemDetailsException } from '../errors/problem-details.exception';

const originalAuthMode = process.env.AUTH_MODE;
const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.AUTH_MODE;
  else process.env.AUTH_MODE = originalAuthMode;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

function context(actor: string): ExecutionContext {
  const request = { headers: { 'x-dev-actor': actor }, ip: '127.0.0.1' };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

describe('development claims guard', () => {
  it('allows only a fixed actor with the required scope', () => {
    process.env.AUTH_MODE = 'mock';
    process.env.NODE_ENV = 'development';
    const reflector = new Reflector();
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['events:write']);
    const guard = new AuthGuard(reflector, new MockClaimsProvider());
    expect(guard.canActivate(context('org-a-manager'))).toBe(true);
    expect(() => guard.canActivate(context('org-a-reader'))).toThrow(ProblemDetailsException);
    expect(() => guard.canActivate(context('unknown'))).toThrow(ProblemDetailsException);
  });

  it('rejects mock credentials outside development', () => {
    process.env.AUTH_MODE = 'mock';
    process.env.NODE_ENV = 'production';
    const guard = new AuthGuard(new Reflector(), new MockClaimsProvider());
    expect(() => guard.canActivate(context('org-a-manager'))).toThrow(ProblemDetailsException);
  });
});
