import { Hono } from 'hono';
import { eq, inArray, desc, and, sql } from 'drizzle-orm';
import {
  db,
  equipment,
  ingredients,
  moods,
  recipes,
  recipeIngredients,
  recipeSteps,
  recipeEquipment,
  users,
  userPreferences,
  recipeRatings,
} from '../db';
import { generateRecipe } from '../services/recipeGenerator';
import { requireAuth, type AuthUser } from '../middleware/auth';
import {
  generateRecipeSchema,
  submitRatingSchema,
  paginationSchema,
  ratingsQuerySchema,
} from '../validation/schemas';
import type {
  Recipe,
  RecipeResponse,
  RecipeListResponse,
  RecipeRatingResponse,
  RecipeRatingListResponse,
  RatingAggregateResponse,
  DeleteRatingResponse,
  MixrErrorResponse,
  RecipeRating,
  RatingAggregate,
} from '@sudobility/mixr_types';

type Variables = {
  user: AuthUser;
};

const app = new Hono<{ Variables: Variables }>();

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
 * POST /api/recipes/generate
 * Generate a new AI cocktail recipe based on equipment, ingredients, and mood.
 * Falls back to user's saved preferences if equipment/ingredient IDs are empty.
 */
app.post('/generate', requireAuth, async c => {
  try {
    const authUser = c.get('user') as AuthUser;
    const body = await c.req.json();

    // Validate request body with Zod
    const parsed = generateRecipeSchema.safeParse(body);
    if (!parsed.success) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: parsed.error.issues.map(i => i.message).join('; '),
        },
        400
      );
    }

    let { equipment_ids, ingredient_ids } = parsed.data;
    const { mood_id } = parsed.data;

    // Ensure user exists
    await getOrCreateUser(authUser);

    // If equipment_ids or ingredient_ids are empty, use user's saved preferences
    if (equipment_ids.length === 0 || ingredient_ids.length === 0) {
      const [prefs] = await db
        .select()
        .from(userPreferences)
        .where(eq(userPreferences.userId, authUser.uid))
        .limit(1);

      if (prefs) {
        if (equipment_ids.length === 0) {
          equipment_ids = prefs.equipmentIds || [];
        }
        if (ingredient_ids.length === 0) {
          ingredient_ids = prefs.ingredientIds || [];
        }
      }
    }

    // Validate that we have equipment and ingredients after preference fallback
    if (equipment_ids.length === 0) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error:
            'equipment_ids must be a non-empty array (no saved preferences found)',
        },
        400
      );
    }

    if (ingredient_ids.length === 0) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error:
            'ingredient_ids must be a non-empty array (no saved preferences found)',
        },
        400
      );
    }

    // Fetch equipment data
    const equipmentData = await db
      .select()
      .from(equipment)
      .where(inArray(equipment.id, equipment_ids));

    if (equipmentData.length === 0) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'No valid equipment found',
        },
        400
      );
    }

    // Fetch ingredient data
    const ingredientData = await db
      .select()
      .from(ingredients)
      .where(inArray(ingredients.id, ingredient_ids));

    if (ingredientData.length === 0) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'No valid ingredients found',
        },
        400
      );
    }

    // Fetch mood data
    const moodData = await db
      .select()
      .from(moods)
      .where(eq(moods.id, mood_id))
      .limit(1);

    if (moodData.length === 0) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'Mood not found',
        },
        404
      );
    }

    const mood = moodData[0];

    // Generate recipe using AI
    const generatedRecipe = await generateRecipe({
      equipmentNames: equipmentData.map(e => e.name),
      ingredientNames: ingredientData.map(i => i.name),
      moodName: mood.name,
      moodDescription: mood.description,
      moodExamples: mood.exampleDrinks,
    });

    // Save recipe + relations in a transaction for atomicity
    const savedRecipe = await db.transaction(async tx => {
      const [recipe] = await tx
        .insert(recipes)
        .values({
          name: generatedRecipe.name,
          description: generatedRecipe.description,
          moodId: mood_id,
          userId: authUser.uid,
        })
        .returning();

      // Batch insert recipe ingredients
      const ingredientValues = generatedRecipe.ingredients
        .map(ri => {
          const matched = ingredientData.find(
            i => i.name.toLowerCase() === ri.name.toLowerCase()
          );
          if (!matched) return null;
          return {
            recipeId: recipe.id,
            ingredientId: matched.id,
            amount: ri.amount,
          };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);

      if (ingredientValues.length > 0) {
        await tx.insert(recipeIngredients).values(ingredientValues);
      }

      // Batch insert recipe steps
      const stepValues = generatedRecipe.steps.map((instruction, i) => ({
        recipeId: recipe.id,
        stepNumber: i + 1,
        instruction,
      }));

      if (stepValues.length > 0) {
        await tx.insert(recipeSteps).values(stepValues);
      }

      // Batch insert recipe equipment
      if (generatedRecipe.equipmentUsed) {
        const equipmentValues = generatedRecipe.equipmentUsed
          .map(name => {
            const matched = equipmentData.find(
              e => e.name.toLowerCase() === name.toLowerCase()
            );
            if (!matched) return null;
            return {
              recipeId: recipe.id,
              equipmentId: matched.id,
            };
          })
          .filter((v): v is NonNullable<typeof v> => v !== null);

        if (equipmentValues.length > 0) {
          await tx.insert(recipeEquipment).values(equipmentValues);
        }
      }

      return recipe;
    });

    // Fetch complete recipe with relations
    const completeRecipe = await getCompleteRecipe(savedRecipe.id);

    return c.json<RecipeResponse>({
      success: true,
      data: completeRecipe!,
    });
  } catch (error) {
    console.error('Recipe generation error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error:
          error instanceof Error ? error.message : 'Failed to generate recipe',
      },
      500
    );
  }
});

/**
 * GET /api/recipes
 * List recipes with pagination. Uses batched queries to avoid N+1.
 */
app.get('/', async c => {
  try {
    const query = paginationSchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
    });

    const limit = query.success ? query.data.limit : 10;
    const offset = query.success ? query.data.offset : 0;

    const allRecipes = await db
      .select()
      .from(recipes)
      .orderBy(desc(recipes.createdAt))
      .limit(limit)
      .offset(offset);

    if (allRecipes.length === 0) {
      return c.json<RecipeListResponse>({
        success: true,
        data: [],
        count: 0,
      });
    }

    // Batched queries to avoid N+1
    const recipesWithDetails = await getCompleteRecipes(allRecipes);

    return c.json<RecipeListResponse>({
      success: true,
      data: recipesWithDetails,
      count: recipesWithDetails.length,
    });
  } catch (_error) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch recipes',
      },
      500
    );
  }
});

/**
 * GET /api/recipes/:id
 * Get a single recipe by ID with all relations.
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
    const recipe = await getCompleteRecipe(id);

    if (!recipe) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'Recipe not found',
        },
        404
      );
    }

    return c.json<RecipeResponse>({
      success: true,
      data: recipe,
    });
  } catch (_error) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch recipe',
      },
      500
    );
  }
});

/**
 * Get a single recipe with all its relations (mood, ingredients, steps, equipment).
 * Used for single-recipe fetches (by ID, after generation).
 */
async function getCompleteRecipe(recipeId: number): Promise<Recipe | null> {
  const [recipe] = await db
    .select()
    .from(recipes)
    .where(eq(recipes.id, recipeId))
    .limit(1);

  if (!recipe) {
    return null;
  }

  // Get mood
  let mood = null;
  if (recipe.moodId) {
    const [moodData] = await db
      .select()
      .from(moods)
      .where(eq(moods.id, recipe.moodId))
      .limit(1);
    mood = moodData
      ? { ...moodData, createdAt: moodData.createdAt.toISOString() }
      : null;
  }

  // Get ingredients
  const recipeIngredientsData = await db
    .select({
      id: recipeIngredients.id,
      amount: recipeIngredients.amount,
      ingredientId: ingredients.id,
      ingredientName: ingredients.name,
      ingredientIcon: ingredients.icon,
    })
    .from(recipeIngredients)
    .innerJoin(ingredients, eq(recipeIngredients.ingredientId, ingredients.id))
    .where(eq(recipeIngredients.recipeId, recipeId));

  // Get steps
  const steps = await db
    .select()
    .from(recipeSteps)
    .where(eq(recipeSteps.recipeId, recipeId))
    .orderBy(recipeSteps.stepNumber);

  // Get equipment
  const recipeEquipmentData = await db
    .select({
      id: recipeEquipment.id,
      equipmentId: equipment.id,
      equipmentName: equipment.name,
      equipmentIcon: equipment.icon,
    })
    .from(recipeEquipment)
    .innerJoin(equipment, eq(recipeEquipment.equipmentId, equipment.id))
    .where(eq(recipeEquipment.recipeId, recipeId));

  return {
    id: recipe.id,
    name: recipe.name,
    description: recipe.description,
    moodId: recipe.moodId,
    createdAt: recipe.createdAt.toISOString(),
    mood,
    ingredients: recipeIngredientsData.map(ri => ({
      id: ri.ingredientId,
      name: ri.ingredientName,
      icon: ri.ingredientIcon,
      amount: ri.amount,
    })),
    steps: steps.map(s => s.instruction),
    equipment: recipeEquipmentData.map(re => ({
      id: re.equipmentId,
      name: re.equipmentName,
      icon: re.equipmentIcon,
    })),
  };
}

/**
 * Batch-fetch complete recipes with all relations.
 * Uses IN queries instead of per-recipe queries to avoid N+1.
 * For a page of 10 recipes, this makes 5 queries instead of 41.
 */
async function getCompleteRecipes(
  recipeList: (typeof recipes.$inferSelect)[]
): Promise<Recipe[]> {
  const recipeIds = recipeList.map(r => r.id);

  // Batch fetch moods for all recipes that have a moodId
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

  // Batch fetch ingredients for all recipes
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

  // Batch fetch steps for all recipes
  const allSteps = await db
    .select()
    .from(recipeSteps)
    .where(inArray(recipeSteps.recipeId, recipeIds))
    .orderBy(recipeSteps.recipeId, recipeSteps.stepNumber);

  // Batch fetch equipment for all recipes
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

  // Group data by recipe ID
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

  // Assemble complete recipes
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
 * POST /api/recipes/:id/ratings
 * Submit or update a rating/review for a recipe (upsert).
 */
app.post('/:id/ratings', requireAuth, async c => {
  const recipeId = parseInt(c.req.param('id'));

  if (isNaN(recipeId)) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Invalid recipe ID',
      },
      400
    );
  }

  try {
    const authUser = c.get('user') as AuthUser;
    const body = await c.req.json();

    // Validate request body with Zod
    const parsed = submitRatingSchema.safeParse(body);
    if (!parsed.success) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: parsed.error.issues.map(i => i.message).join('; '),
        },
        400
      );
    }

    const { stars, review } = parsed.data;

    // Ensure user exists
    const user = await getOrCreateUser(authUser);

    // Check if recipe exists
    const [recipe] = await db
      .select()
      .from(recipes)
      .where(eq(recipes.id, recipeId))
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

    // Upsert rating (insert or update if already exists)
    const [rating] = await db
      .insert(recipeRatings)
      .values({
        recipeId,
        userId: authUser.uid,
        stars,
        review: review || null,
      })
      .onConflictDoUpdate({
        target: [recipeRatings.userId, recipeRatings.recipeId],
        set: {
          stars,
          review: review || null,
          updatedAt: new Date(),
        },
      })
      .returning();

    const ratingData: RecipeRating = {
      id: rating.id,
      recipe_id: rating.recipeId,
      user_id: rating.userId,
      user_name: user?.displayName || 'Anonymous',
      user_email: user?.email || '',
      stars: rating.stars,
      review: rating.review,
      created_at: rating.createdAt.toISOString(),
      updated_at: rating.updatedAt.toISOString(),
    };

    return c.json<RecipeRatingResponse>({
      success: true,
      data: ratingData,
    });
  } catch (error) {
    console.error('Submit rating error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to submit rating',
      },
      500
    );
  }
});

/**
 * GET /api/recipes/:id/ratings
 * List all ratings for a recipe with pagination and sorting.
 */
app.get('/:id/ratings', async c => {
  const recipeId = parseInt(c.req.param('id'));

  if (isNaN(recipeId)) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Invalid recipe ID',
      },
      400
    );
  }

  try {
    // Validate query params with Zod
    const query = ratingsQuerySchema.safeParse({
      limit: c.req.query('limit'),
      offset: c.req.query('offset'),
      sort: c.req.query('sort'),
    });

    const { limit, offset, sort } = query.success
      ? query.data
      : { limit: 20, offset: 0, sort: 'newest' as const };

    // Determine sort order
    let orderClause;
    switch (sort) {
      case 'oldest':
        orderClause = recipeRatings.createdAt;
        break;
      case 'highest':
        orderClause = desc(recipeRatings.stars);
        break;
      case 'lowest':
        orderClause = recipeRatings.stars;
        break;
      case 'newest':
      default:
        orderClause = desc(recipeRatings.createdAt);
    }

    const ratings = await db
      .select({
        id: recipeRatings.id,
        recipeId: recipeRatings.recipeId,
        userId: recipeRatings.userId,
        userName: users.displayName,
        userEmail: users.email,
        stars: recipeRatings.stars,
        review: recipeRatings.review,
        createdAt: recipeRatings.createdAt,
        updatedAt: recipeRatings.updatedAt,
      })
      .from(recipeRatings)
      .innerJoin(users, eq(recipeRatings.userId, users.id))
      .where(eq(recipeRatings.recipeId, recipeId))
      .orderBy(orderClause)
      .limit(limit)
      .offset(offset);

    // Get total count
    const [countResult] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(recipeRatings)
      .where(eq(recipeRatings.recipeId, recipeId));

    const ratingsList: RecipeRating[] = ratings.map(r => ({
      id: r.id,
      recipe_id: r.recipeId,
      user_id: r.userId,
      user_name: r.userName || 'Anonymous',
      user_email: r.userEmail,
      stars: r.stars,
      review: r.review,
      created_at: r.createdAt.toISOString(),
      updated_at: r.updatedAt.toISOString(),
    }));

    return c.json<RecipeRatingListResponse>({
      success: true,
      data: ratingsList,
      count: countResult.count,
    });
  } catch (error) {
    console.error('Get ratings error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch ratings',
      },
      500
    );
  }
});

/**
 * GET /api/recipes/:id/ratings/aggregate
 * Get aggregate rating statistics (average, total, distribution) for a recipe.
 */
app.get('/:id/ratings/aggregate', async c => {
  const recipeId = parseInt(c.req.param('id'));

  if (isNaN(recipeId)) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Invalid recipe ID',
      },
      400
    );
  }

  try {
    // Get aggregate stats
    const [stats] = await db
      .select({
        totalRatings: sql<number>`count(*)::int`,
        averageRating: sql<number>`round(avg(${recipeRatings.stars})::numeric, 1)::float`,
      })
      .from(recipeRatings)
      .where(eq(recipeRatings.recipeId, recipeId));

    // Get distribution
    const distribution = await db
      .select({
        stars: recipeRatings.stars,
        count: sql<number>`count(*)::int`,
      })
      .from(recipeRatings)
      .where(eq(recipeRatings.recipeId, recipeId))
      .groupBy(recipeRatings.stars);

    // Create distribution object
    const ratingDistribution: RatingAggregate['rating_distribution'] = {
      '1': 0,
      '2': 0,
      '3': 0,
      '4': 0,
      '5': 0,
    };

    distribution.forEach(d => {
      ratingDistribution[
        d.stars.toString() as keyof typeof ratingDistribution
      ] = d.count;
    });

    const aggregateData: RatingAggregate = {
      recipe_id: recipeId,
      average_rating: stats.averageRating || 0,
      total_ratings: stats.totalRatings || 0,
      rating_distribution: ratingDistribution,
    };

    return c.json<RatingAggregateResponse>({
      success: true,
      data: aggregateData,
    });
  } catch (error) {
    console.error('Get aggregate ratings error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to fetch aggregate ratings',
      },
      500
    );
  }
});

/**
 * DELETE /api/recipes/:recipeId/ratings/:ratingId
 * Delete a rating. Only the rating owner can delete their own rating.
 */
app.delete('/:recipeId/ratings/:ratingId', requireAuth, async c => {
  const recipeId = parseInt(c.req.param('recipeId'));
  const ratingId = parseInt(c.req.param('ratingId'));

  if (isNaN(recipeId) || isNaN(ratingId)) {
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Invalid recipe ID or rating ID',
      },
      400
    );
  }

  try {
    const authUser = c.get('user') as AuthUser;

    // Check if rating exists and belongs to user
    const [rating] = await db
      .select()
      .from(recipeRatings)
      .where(
        and(
          eq(recipeRatings.id, ratingId),
          eq(recipeRatings.recipeId, recipeId),
          eq(recipeRatings.userId, authUser.uid)
        )
      )
      .limit(1);

    if (!rating) {
      return c.json<MixrErrorResponse>(
        {
          success: false,
          error: 'Rating not found or you do not have permission to delete it',
        },
        404
      );
    }

    // Delete rating
    await db.delete(recipeRatings).where(eq(recipeRatings.id, ratingId));

    return c.json<DeleteRatingResponse>({
      success: true,
      data: { message: 'Rating deleted successfully' },
    });
  } catch (error) {
    console.error('Delete rating error:', error);
    return c.json<MixrErrorResponse>(
      {
        success: false,
        error: 'Failed to delete rating',
      },
      500
    );
  }
});

export default app;
