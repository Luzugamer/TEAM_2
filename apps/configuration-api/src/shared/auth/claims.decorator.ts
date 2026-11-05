import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TenantClaims } from './tenant-claims.interface';

export const Claims = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): TenantClaims => {
    const request = ctx.switchToHttp().getRequest();
    return request.user;
  },
);

