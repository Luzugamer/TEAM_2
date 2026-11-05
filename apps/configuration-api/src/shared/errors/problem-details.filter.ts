import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { ProblemDetailsException, ProblemDetailsPayload } from './problem-details.exception';

function requestErrors(messages: unknown): NonNullable<ProblemDetailsPayload['errors']> {
  if (!Array.isArray(messages)) return [];
  return messages.map((message) => {
    const text = String(message);
    const property = text.match(/^property\s+([^\s]+)/i)?.[1]
      || text.match(/^([a-z][a-z0-9_.-]+)\s+(?:must|should|is|cannot)\b/i)?.[1];
    return {
      pointer: property ? `/body/${property}` : '/body',
      code: 'invalid_parameter',
      message: text,
    };
  });
}

@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let problem: ProblemDetailsPayload;

    if (exception instanceof ProblemDetailsException) {
      problem = {
        ...exception.problem,
        request_id: request.headers['x-request-id'] as string,
        instance: request.originalUrl || request.url,
      };
    } else if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();

      if (typeof res === 'object' && res !== null) {
        const body = res as Record<string, unknown>;
        const message = body.message;
        problem = {
          type: `urn:problem:${status}`,
          title: (body.error as string) || exception.name || 'HTTP Error',
          status,
          detail: Array.isArray(message) ? message.join('; ') : String(message || exception.message),
          instance: request.originalUrl || request.url,
          code: status === HttpStatus.BAD_REQUEST ? 'bad_request' : `http_${status}`,
          request_id: request.headers['x-request-id'] as string,
          errors: requestErrors(message),
        };
      } else {
        problem = {
          type: `urn:problem:${status}`,
          title: exception.name || 'HTTP Error',
          status,
          detail: String(res),
          instance: request.originalUrl || request.url,
          code: `http_${status}`,
          request_id: request.headers['x-request-id'] as string,
          errors: [],
        };
      }
    } else {
      this.logger.error('Unhandled internal exception:', exception);
      problem = {
        type: 'urn:problem:internal-server-error',
        title: 'Internal Server Error',
        status: HttpStatus.INTERNAL_SERVER_ERROR,
        detail: 'An unexpected internal error occurred.',
        instance: request.originalUrl || request.url,
        code: 'internal_error',
        request_id: request.headers['x-request-id'] as string,
        errors: [],
      };
    }

    response.status(problem.status);
    response.setHeader('Content-Type', 'application/problem+json');
    response.json(problem);
  }
}

