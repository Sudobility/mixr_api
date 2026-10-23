import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, equipment } from '../db';
import {
  EQUIPMENT_SUBCATEGORIES,
  type EquipmentSubcategory,
  type EquipmentListResponse,
  type EquipmentResponse,
  type EquipmentSubcategoriesResponse,
  type MixrErrorResponse,
} from '@sudobility/mixr_types';

const app = new Hono();

/**
 * GET /api/equipment
 * List all equipment, optionally filtered by subcategory query parameter.
 */
app.get('/', async c => {
  const subcategory = c.req.query('subcategory') as
    EquipmentSubcategory | undefined;

  try {
    let results;
    if (subcategory) {
      results = await db
        .select()
        .from(equipment)
        .where(eq(equipment.subcategory, subcategory));
    } else {
      results = await db.select().from(equipment);
    }

    return c.json<EquipmentListResponse>({
      success: true,
      data: results.map(r => ({
        ...r,
        createdAt: r.createdAt.toISOString(),
      })),
      count: results.length,
    });
  } catch (_error) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch equipment',
      },
      500
    );
  }
});

/**
 * GET /api/equipment/subcategories
 * List all valid equipment subcategory values.
 */
app.get('/subcategories', async c => {
  return c.json<EquipmentSubcategoriesResponse>({
    success: true,
    data: [...EQUIPMENT_SUBCATEGORIES],
  });
});

/**
 * GET /api/equipment/:id
 * Get a single equipment item by ID.
 */
app.get('/:id', async c => {
  const id = parseInt(c.req.param('id'));

  if (isNaN(id)) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Invalid ID',
      },
      400
    );
  }

  try {
    const result = await db
      .select()
      .from(equipment)
      .where(eq(equipment.id, id))
      .limit(1);

    if (result.length === 0) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'Equipment not found',
        },
        404
      );
    }

    return c.json<EquipmentResponse>({
      success: true,
      data: {
        ...result[0],
        createdAt: result[0].createdAt.toISOString(),
      },
    });
  } catch (_error) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch equipment',
      },
      500
    );
  }
});

export default app;
