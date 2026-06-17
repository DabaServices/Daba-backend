import type { NextFunction, Request, Response } from 'express';

type AccessCheckResponse = {
  allowed?: boolean;
  reason?: string;
  body?: {
    data?: {
      allowed?: boolean;
      reason?: string;
    };
  };
};

const DEFAULT_APPLICATION_ID = 'DABA';

const SKIPPED_PREFIXES = [
  '/health',
  '/server-time',
];

const normalizeHost = (host: string) => host.trim().replace(/\/$/, '');

const decodeJwtPayload = (authorization?: string): Record<string, any> | null => {
  const token = authorization?.replace(/^Bearer\s+/i, '').trim();
  if (!token) return null;

  const [, payload] = token.split('.');
  if (!payload) return null;

  try {
    return JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch {
    return null;
  }
};

const getUsername = (request: Request): string => {
  const payload = decodeJwtPayload(String(request.headers.authorization ?? ''));

  return String(
    request.headers.username ??
    request.headers['x-user-id'] ??
    request.query?.username ??
    payload?.username ??
    payload?.user ??
    payload?.sub ??
    '',
  ).trim().toUpperCase();
};

const shouldSkip = (request: Request) => {
  if (request.method === 'OPTIONS') return true;

  const path = request.path || request.url || '';
  if (SKIPPED_PREFIXES.some(prefix => path.startsWith(prefix))) return true;

  return request.method === 'POST' && (path === '/api/logs' || path === '/logs');
};

const respond = (response: Response, statusCode: number, message: string) =>
  response.status(statusCode).json({
    success: false,
    statusCode,
    body: {
      data: null,
      message,
      type: statusCode >= 500 ? 'Fatal' : 'Failure',
    },
  });

export class ApplicationAccessMiddleware {
  async use(request: Request, response: Response, next: NextFunction) {
    const authorityHost = process.env.AUTHORITY_SERVICE_HOST?.trim();
    const applicationId = (process.env.APPLICATION_ID ?? DEFAULT_APPLICATION_ID).trim().toUpperCase();

    if (!applicationId || shouldSkip(request)) {
      return next();
    }

    const username = getUsername(request);
    if (!username) {
      return respond(response, 401, 'בדיקת ההרשאות נכשלה, יש לנסות שוב');
    }

    const controller = new AbortController();

    try {
      const accessResponse = await fetch(`${normalizeHost(authorityHost)}/api/access/check`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          username,
          applicationId,
          authorization: request.headers.authorization,
        }),
        signal: controller.signal,
      });

      if (!accessResponse.ok) {
        return respond(
          response,
          503,
          'שגיאה בבדיקת ההרשאות, יש לנסות שוב'
        );
      }

      const payload = await accessResponse.json() as AccessCheckResponse;
      const result = payload.body?.data ?? payload;

      if (result.allowed) return next();

      return respond(response, 403, `נראה שאינך מורשה להכנס לכאן, יש לפנות לתמיכה`);
    } catch (error) {
      if (process.env.AUTHORITY_FAIL_OPEN === 'true') {
        return next();
      }

      return respond(
        response,
        503,
        'שגיאה בבדיקת ההרשאות, יש לנסות שוב'
      );
    }
  }
}
