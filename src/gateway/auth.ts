import crypto from 'node:crypto';
import type { RequestHandler } from 'express';

export function maskSecret(secret: string | undefined | null): string {
  if (!secret) {
    return 'missing';
  }

  if (secret.length <= 8) {
    return '********';
  }

  return `${secret.slice(0, 4)}...${secret.slice(-4)}`;
}

export function constantTimeSecretEquals(expected: string, provided: string | null | undefined): boolean {
  if (!provided) {
    return false;
  }

  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);
  if (expectedBuffer.length !== providedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(expectedBuffer, providedBuffer);
}

export function createHttpSecretMiddleware(expectedSecret: string): RequestHandler {
  return (request, response, next) => {
    const headerValue = request.header('X-Router-Secret');
    if (!constantTimeSecretEquals(expectedSecret, headerValue)) {
      response.status(401).json({ error: 'Unauthorized' });
      return;
    }

    next();
  };
}
