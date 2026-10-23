import { Hono } from 'hono';
import { eq, desc, and, inArray } from 'drizzle-orm';
import {
  db,
  users,
  userPreferences,
  recipes,
  userFavorites,
  recipeIngredients,
  recipeSteps,
  recipeEquipment,
  equipment,
  ingredients,
  moods,
} from '../db';
import { requireAuth, type AuthUser } from '../middleware/auth';
import {
  updateUserSchema,
  updatePreferencesSchema,
  addFavoriteSchema,
  paginationSchema,
} from '../validation/schemas';
import type {
  UserResponse,
  UserPreferencesResponse,
  RecipeListResponse,
  AddFavoriteResponse,
  RemoveFavoriteResponse,
  MixrErrorResponse,
  Recipe,
  User,
  UserPreferences,
} from '@sudobility/mixr_types';

type Variables = {
  user: AuthUser;
};

const app = new Hono<{ Variables: Variables }>();

// Apply auth middleware to all /me routes
app.use('/me/*', requireAuth);

/**
 * Get or create a user record from the auth token.
 * Auto-creates on first API call using Firebase UID and email.
 */
async function getOrCreateUser(authUser: AuthUser) {
  let [user] = await db
    .select()
    .from(users)
    .where(eq(users.id, authUser.uid))
    .limit(1);

  if (!user && authUser.email) {
    [user] = await db
      .insert(users)
      .values({
        id: authUser.uid,
        email: authUser.email,
        displayName: authUser.email.split('@')[0],
      })
      .returning();
  }

  return user;
}

/**
 * Batch-fetch complete recipes with all relations.
 * Uses IN queries instead of per-recipe queries to avoid N+1.
 */
async function getCompleteRecipes(
  recipeList: (typeof recipes.$inferSelect)[]
): Promise<Recipe[]> {
  if (recipeList.length === 0) return [];

  const recipeIds = recipeList.map(r => r.id);

  // Batch fetch moods
  const moodIds = [
    ...new Set(
      recipeList.map(r => r.moodId).filter((id): id is number => id !== null)
    ),
  ];
  const moodsData =
    moodIds.length > 0
      ? await db.select().from(moods).where(inArray(moods.id, moodIds))
      : [];
  const moodMap = new Map(
    moodsData.map(m => [m.id, { ...m, createdAt: m.createdAt.toISOString() }])
  );

  // Batch fetch ingredients
  const allIngredients = await db
    .select({
      recipeId: recipeIngredients.recipeId,
      amount: recipeIngredients.amount,
      ingredientId: ingredients.id,
      ingredientName: ingredients.name,
      ingredientIcon: ingredients.icon,
    })
    .from(recipeIngredients)
    .innerJoin(ingredients, eq(recipeIngredients.ingredientId, ingredients.id))
    .where(inArray(recipeIngredients.recipeId, recipeIds));

  // Batch fetch steps
  const allSteps = await db
    .select()
    .from(recipeSteps)
    .where(inArray(recipeSteps.recipeId, recipeIds))
    .orderBy(recipeSteps.recipeId, recipeSteps.stepNumber);

  // Batch fetch equipment
  const allEquipment = await db
    .select({
      recipeId: recipeEquipment.recipeId,
      equipmentId: equipment.id,
      equipmentName: equipment.name,
      equipmentIcon: equipment.icon,
    })
    .from(recipeEquipment)
    .innerJoin(equipment, eq(recipeEquipment.equipmentId, equipment.id))
    .where(inArray(recipeEquipment.recipeId, recipeIds));

  // Group by recipe ID
  const ingredientsByRecipe = new Map<number, typeof allIngredients>();
  for (const ing of allIngredients) {
    const list = ingredientsByRecipe.get(ing.recipeId) || [];
    list.push(ing);
    ingredientsByRecipe.set(ing.recipeId, list);
  }

  const stepsByRecipe = new Map<number, typeof allSteps>();
  for (const step of allSteps) {
    const list = stepsByRecipe.get(step.recipeId) || [];
    list.push(step);
    stepsByRecipe.set(step.recipeId, list);
  }

  const equipmentByRecipe = new Map<number, typeof allEquipment>();
  for (const eqItem of allEquipment) {
    const list = equipmentByRecipe.get(eqItem.recipeId) || [];
    list.push(eqItem);
    equipmentByRecipe.set(eqItem.recipeId, list);
  }

  return recipeList.map((recipe): Recipe => ({
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    moodId: recipe.moodId,
    createdAt: recipe.createdAt.toISOString(),
    mood: recipe.moodId ? moodMap.get(recipe.moodId) || null : null,
    ingredients: (ingredientsByRecipe.get(recipe.id) || []).map(ri => ({
      id: ri.ingredientId,
      name: ri.ingredientName,
      icon: ri.ingredientIcon,
      amount: ri.amount,
    })),
    steps: (stepsByRecipe.get(recipe.id) || []).map(s => s.instruction),
    equipment: (equipmentByRecipe.get(recipe.id) || []).map(re => ({
      id: re.equipmentId,
      name: re.equipmentName,
      icon: re.equipmentIcon,
    })),
  }));
}

/**
 * GET /api/users/me
 * Get current user's profile. Auto-creates user on first call.
 */
app.get('/me', async c => {
  try {
    const authUser = c.get('user') as AuthUser;
    const user = await getOrCreateUser(authUser);

    if (!user) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'User not found',
        },
        404
      );
    }

    const userData: User = {
      id: user.id,
      email: user.email,
      display_name: user.displayName || '',
      created_at: user.createdAt.toISOString(),
      updated_at: user.updatedAt.toISOString(),
    };

    return c.json<UserResponse>({
      success: true,
      data: userData,
    });
  } catch (error) {
    console.error('Get user error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch user',
      },
      500
    );
  }
});

/**
 * PUT /api/users/me
 * Update current user's display name.
 */
app.put('/me', async c => {
  try {
    const authUser = c.get('user') as AuthUser;
    const body = await c.req.json();

    // Validate request body with Zod
    const parsed = updateUserSchema.safeParse(body);
    if (!parsed.success) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: parsed.error.issues.map(i => i.message).join('; '),
        },
        400
      );
    }

    const { display_name } = parsed.data;

    // Ensure user exists
    await getOrCreateUser(authUser);

    // Update user
    const [updatedUser] = await db
      .update(users)
      .set({
        displayName: display_name,
        updatedAt: new Date(),
      })
      .where(eq(users.id, authUser.uid))
      .returning();

    const userData: User = {
      id: updatedUser.id,
      email: updatedUser.email,
      display_name: updatedUser.displayName || '',
      created_at: updatedUser.createdAt.toISOString(),
      updated_at: updatedUser.updatedAt.toISOString(),
    };

    return c.json<UserResponse>({
      success: true,
      data: userData,
    });
  } catch (error) {
    console.error('Update user error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to update user',
      },
      500
    );
  }
});

/**
 * GET /api/users/me/preferences
 * Get user's equipment and ingredient preference IDs.
 */
app.get('/me/preferences', async c => {
  try {
    const authUser = c.get('user') as AuthUser;

    // Ensure user exists
    await getOrCreateUser(authUser);

    const [prefs] = await db
      .select()
      .from(userPreferences)
      .where(eq(userPreferences.userId, authUser.uid))
      .limit(1);

    if (!prefs) {
      const defaultPrefs: UserPreferences = {
        equipment_ids: [],
        ingredient_ids: [],
        updated_at: new Date().toISOString(),
      };
      return c.json<UserPreferencesResponse>({
        success: true,
        data: defaultPrefs,
      });
    }

    const prefsData: UserPreferences = {
      equipment_ids: prefs.equipmentIds || [],
      ingredient_ids: prefs.ingredientIds || [],
      updated_at: prefs.updatedAt.toISOString(),
    };

    return c.json<UserPreferencesResponse>({
      success: true,
      data: prefsData,
    });
  } catch (error) {
    console.error('Get preferences error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch preferences',
      },
      500
    );
  }
});

/**
 * PUT /api/users/me/preferences
 * Update user's equipment and ingredient preferences (upsert).
 */
app.put('/me/preferences', async c => {
  try {
    const authUser = c.get('user') as AuthUser;
    const body = await c.req.json();

    // Validate request body with Zod
    const parsed = updatePreferencesSchema.safeParse(body);
    if (!parsed.success) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: parsed.error.issues.map(i => i.message).join('; '),
        },
        400
      );
    }

    const { equipment_ids, ingredient_ids } = parsed.data;

    // Ensure user exists
    await getOrCreateUser(authUser);

    // Upsert preferences
    const [prefs] = await db
      .insert(userPreferences)
      .values({
        userId: authUser.uid,
        equipmentIds: equipment_ids,
        ingredientIds: ingredient_ids,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userPreferences.userId,
        set: {
          equipmentIds: equipment_ids,
          ingredientIds: ingredient_ids,
          updatedAt: new Date(),
        },
      })
      .returning();

    const prefsData: UserPreferences = {
      equipment_ids: prefs.equipmentIds || [],
      ingredient_ids: prefs.ingredientIds || [],
      updated_at: prefs.updatedAt.toISOString(),
    };

    return c.json<UserPreferencesResponse>({
      success: true,
      data: prefsData,
    });
  } catch (error) {
    console.error('Update preferences error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to update preferences',
      },
      500
    );
  }
});

/**
 * GET /api/users/me/recipes
 * Get recipes generated by the current user with pagination.
 */
app.get('/me/recipes', async c => {
  try {
    const authUser = c.get('user') as AuthUser;

    const query = paginationSchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });

    const limit = query.success ? query.data.limit : 20;
    const offset = query.success ? query.data.offset : 0;

    // Ensure user exists
    await getOrCreateUser(authUser);

    const userRecipes = await db
      .select()
      .from(recipes)
      .where(eq(recipes.userId, authUser.uid))
      .orderBy(desc(recipes.createdAt))
      .limit(limit)
      .offset(offset);

    // Use batched query to avoid N+1
    const recipesWithDetails = await getCompleteRecipes(userRecipes);

    return c.json<RecipeListResponse>({
      success: true,
      data: recipesWithDetails,
      count: recipesWithDetails.length,
    });
  } catch (error) {
    console.error('Get user recipes error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch user recipes',
      },
      500
    );
  }
});

/**
 * GET /api/users/me/favorites
 * Get user's favorite recipes with pagination.
 */
app.get('/me/favorites', async c => {
  try {
    const authUser = c.get('user') as AuthUser;

    const query = paginationSchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });

    const limit = query.success ? query.data.limit : 20;
    const offset = query.success ? query.data.offset : 0;

    // Ensure user exists
    await getOrCreateUser(authUser);

    const favorites = await db
      .select({
        recipeId: userFavorites.recipeId,
        createdAt: userFavorites.createdAt,
      })
      .from(userFavorites)
      .where(eq(userFavorites.userId, authUser.uid))
      .orderBy(desc(userFavorites.createdAt))
      .limit(limit)
      .offset(offset);

    if (favorites.length === 0) {
      return c.json<RecipeListResponse>({
        success: true,
        data: [],
        count: 0,
      });
    }

    // Fetch the actual recipes
    const favoriteRecipeIds = favorites.map(f => f.recipeId);
    const favoriteRecipes = await db
      .select()
      .from(recipes)
      .where(inArray(recipes.id, favoriteRecipeIds));

    // Use batched query to avoid N+1
    const recipesWithDetails = await getCompleteRecipes(favoriteRecipes);

    return c.json<RecipeListResponse>({
      success: true,
      data: recipesWithDetails,
      count: recipesWithDetails.length,
    });
  } catch (error) {
    console.error('Get favorites error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch favorites',
      },
      500
    );
  }
});

/**
 * POST /api/users/me/favorites
 * Add a recipe to the user's favorites.
 */
app.post('/me/favorites', async c => {
  try {
    const authUser = c.get('user') as AuthUser;
    const body = await c.req.json();

    // Validate request body with Zod
    const parsed = addFavoriteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: parsed.error.issues.map(i => i.message).join('; '),
        },
        400
      );
    }

    const { recipe_id } = parsed.data;

    // Ensure user exists
    await getOrCreateUser(authUser);

    // Check if recipe exists
    const [recipe] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.id, recipe_id))
      .limit(1);

    if (!recipe) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'Recipe not found',
        },
        404
      );
    }

    // Add to favorites (insert or ignore if already exists)
    await db
      .insert(userFavorites)
      .values({
        userId: authUser.uid,
        recipeId: recipe_id,
      })
      .onConflictDoNothing();

    return c.json<AddFavoriteResponse>({
      success: true,
      message: 'Recipe added to favorites',
    });
  } catch (error) {
    console.error('Add favorite error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to add favorite',
      },
      500
    );
  }
});

/**
 * DELETE /api/users/me/favorites/:recipeId
 * Remove a recipe from the user's favorites.
 */
app.delete('/me/favorites/:recipeId', async c => {
  try {
    const authUser = c.get('user') as AuthUser;
    const recipeId = parseInt(c.req.param('recipeId'));

    if (isNaN(recipeId)) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'Invalid recipe ID',
        },
        400
      );
    }

    // Ensure user exists
    await getOrCreateUser(authUser);

    // Delete favorite
    await db
      .delete(userFavorites)
      .where(
        and(
          eq(userFavorites.userId, authUser.uid),
          eq(userFavorites.recipeId, recipeId)
        )
      );

    return c.json<RemoveFavoriteResponse>({
      success: true,
      message: 'Recipe removed from favorites',
    });
  } catch (error) {
    console.error('Remove favorite error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to remove favorite',
      },
      500
    );
  }
});

export default app;
