import { describe, test, expect } from 'vitest';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { errorHandler } from '../../src/middleware/errorHandler';

function createTestApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app;
}

describe('errorHandler', () => {
  test('returns structured error for HTTPException with custom status', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(403, { message: 'Forbidden access' });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: 'Forbidden access',
    });
    // Canonical envelope adds an ISO timestamp.
    expect(typeof body.timestamp).toBe('string');
  });

  test('returns 401 for unauthorized HTTPException', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new HTTPException(401, { message: 'Invalid token' });
    });

    const res = await app.request('/test');
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Invalid token');
  });

  test('returns 500 with generic message for non-HTTP errors', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('Database connection lost');
    });

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({
      success: false,
      error: 'Internal server error',
    });
    // Canonical envelope adds an ISO timestamp.
    expect(typeof body.timestamp).toBe('string');
  });

  test('does not leak error details for generic errors', async () => {
    const app = createTestApp();
    app.get('/test', () => {
      throw new Error('SECRET_KEY=abc123');
    });

    const res = await app.request('/test');
    const body = await res.json();
    expect(body.error).toBe('Internal server error');
    expect(JSON.stringify(body)).not.toContain('SECRET_KEY');
  });
});
