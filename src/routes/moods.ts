import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { successResponse, errorResponse } from '@sudobility/types';
import { db, moods } from '../db';
import type {
  MoodListResponse,
  MoodResponse,
  MixrErrorResponse,
  Mood,
} from '@sudobility/mixr_types';

const app = new Hono();

/** Convert a Drizzle mood row (Date createdAt) to the Mood type (string createdAt). */
function toMood(row: typeof moods.$inferSelect): Mood {
  return {
    ...row,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * GET /api/moods
 * List all mood options for recipe generation.
 */
app.get('/', async c => {
  try {
    const results = await db.select().from(moods);

    return c.json<MoodListResponse>(successResponse(results.map(toMood)));
  } catch (_error) {
    return c.json<MixrErrorResponse>(
      errorResponse('Failed to fetch moods'),
      500
    );
  }
});

/**
 * GET /api/moods/:id
 * Get a single mood by ID.
 */
app.get('/:id', async c => {
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json<MixrErrorResponse>(errorResponse('Invalid ID'), 400);
  }

  try {
    const result = await db
      .select()
      .from(moods)
      .where(eq(moods.id, id))
      .limit(1);

    if (result.length === 0) {
      return c.json<MixrErrorResponse>(errorResponse('Mood not found'), 404);
    }

    return c.json<MoodResponse>(successResponse(toMood(result[0])));
  } catch (_error) {
    return c.json<MixrErrorResponse>(
      errorResponse('Failed to fetch mood'),
      500
    );
  }
});

export default app;
