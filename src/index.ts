import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { prettyJSON } from 'hono/pretty-json';
import { errorHandler } from './middleware/errorHandler';
import { env } from './config/env';
import {
  successResponse,
  errorResponse,
  type ApiInfoResponse,
  type BaseResponse,
  type HealthResponse,
} from '@sudobility/types';
import type { MixrErrorResponse } from '@sudobility/mixr_types';

// Import routes
import equipmentRoutes from './routes/equipment';
import ingredientsRoutes from './routes/ingredients';
import moodsRoutes from './routes/moods';
import recipesRoutes from './routes/recipes';
import usersRoutes from './routes/users';
import subscriptionsRoutes from './routes/subscriptions';

const app = new Hono();

// Middleware
app.use('*', logger());
app.use('*', prettyJSON());
// CORS: use CORS_ORIGINS env var in production, '*' in development
const corsOrigin = env.CORS_ORIGINS
  ? env.CORS_ORIGINS.split(',').map(o => o.trim())
  : '*';
app.use(
  '*',
  cors({
    origin: corsOrigin,
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// Error handling
app.onError(errorHandler);

// Service info
app.get('/', c => {
  return c.json<ApiInfoResponse>({
    name: 'MIXR API',
    version: '0.0.1',
    status: 'ok',
  });
});

// Health check
app.get('/health', c => {
  return c.json<BaseResponse<HealthResponse>>(
    successResponse({ status: 'healthy', version: '0.0.1' })
  );
});

// API Routes
app.route('/api/equipment', equipmentRoutes);
app.route('/api/ingredients', ingredientsRoutes);
app.route('/api/moods', moodsRoutes);
app.route('/api/recipes', recipesRoutes);
app.route('/api/users', usersRoutes);
app.route('/api/v1/users', subscriptionsRoutes);

// 404 handler
app.notFound(c => {
  return c.json<MixrErrorResponse>(errorResponse('Route not found'), 404);
});

// Start server
const port = parseInt(env.PORT);

console.log(`
╔════════════════════════════════════════╗
║                                        ║
║     🍸 MIXR API Server Starting 🍸     ║
║                                        ║
╚════════════════════════════════════════╝

Environment: ${env.NODE_ENV}
Port: ${port}
API: http://localhost:${port}
Health: http://localhost:${port}/health

Available endpoints:
  GET    /api/equipment
  GET    /api/equipment/:id
  GET    /api/equipment/subcategories

  GET    /api/ingredients
  GET    /api/ingredients/:id
  GET    /api/ingredients/subcategories

  GET    /api/moods
  GET    /api/moods/:id

  POST   /api/recipes/generate (🔐 auth required)
  GET    /api/recipes
  GET    /api/recipes/:id
  POST   /api/recipes/:id/ratings (🔐 auth required)
  GET    /api/recipes/:id/ratings
  GET    /api/recipes/:id/ratings/aggregate
  DELETE /api/recipes/:recipeId/ratings/:ratingId (🔐 auth required)

  GET    /api/users/me (🔐 auth required)
  PUT    /api/users/me (🔐 auth required)
  GET    /api/users/me/preferences (🔐 auth required)
  PUT    /api/users/me/preferences (🔐 auth required)
  GET    /api/users/me/recipes (🔐 auth required)
  GET    /api/users/me/favorites (🔐 auth required)
  POST   /api/users/me/favorites (🔐 auth required)
  DELETE /api/users/me/favorites/:recipeId (🔐 auth required)

🔐 = Requires Firebase authentication token

Ready to mix some cocktails! 🎉
`);

export default {
  port,
  fetch: app.fetch,
};
