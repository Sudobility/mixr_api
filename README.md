# MIXR API

Backend API server for MIXR -- an AI-powered cocktail recipe generation platform.
Given a user's available equipment, ingredients, and a mood, it generates cocktail
recipes with an LLM and persists them (with ratings and favorites) to PostgreSQL.

## Tech Stack

- **Runtime**: Bun (TypeScript, ESM) + [Hono](https://hono.dev)
- **Database**: PostgreSQL with Drizzle ORM (schema: `mixr`)
- **Auth**: Firebase Admin SDK (falls back to a mock dev user when unconfigured)
- **AI**: OpenAI (`gpt-4`) or any OpenAI-compatible endpoint such as LM Studio
- **Validation**: Zod
- **Subscriptions**: `@sudobility/subscription_service` (RevenueCat), optional

> Package manager is **Bun** -- do not use npm/yarn/pnpm to install dependencies.
> Private `@sudobility/*` packages resolve from GitHub Packages (see `.npmrc`); you
> need a GitHub token with `read:packages` to `bun install`.

## Setup

```bash
bun install
cp .env.example .env                 # fill in DATABASE_URL, Firebase creds, OPENAI_API_KEY
bun run db:generate                  # generate SQL migrations from the Drizzle schema
bun run db:migrate                   # apply migrations
bun run db:seed                      # seed equipment (26), ingredients (91), moods (8)
bun run dev                          # start dev server on port 6174
```

Env files are loaded with priority `process.env` > `.env.local` > `.env`
(`.env.local` is a local-only override). See [Environment Variables](#environment-variables).

## Development

```bash
bun run dev              # dev server with hot reload
bun run start            # run from source (src/index.ts)
bun run build            # bundle to dist/ (bun build)
bun run start:prod       # run the built dist/index.js
bun run test:unit        # unit tests (Vitest; excludes *.db.test.ts) -- what CI runs
bun run test:watch       # Vitest watch mode
bun run test:db          # DB/integration suites (manual; see Testing)
bun run lint             # ESLint over src
bun run typecheck        # tsc --noEmit
bun run format           # Prettier write over src
bun run db:studio        # open Drizzle Studio
```

> There is no `bun run test` script. Use `bun run test:unit`.

## Testing

- `bun run test:unit` (`vitest.config.ts`) runs the pure unit tests and never touches
  a database -- this is what CI runs.
- `bun run test:db` (`vitest.db.config.ts`) runs only the `*.db.test.ts` suites. These
  are **manual** and require external services:
  - a PostgreSQL reachable at `TEST_DATABASE_URL` (the guard requires host `localhost`),
  - the API running on `:6174` (`src/integration.db.test.ts`),
  - LM Studio on `:1234` (`src/llm-studio.db.test.ts`).
  Use `./run-integration-tests.sh`, which starts the server for you.

## API Routes

All routes return `{ success, data?, error?, count?, ... }`.

### Public

- `GET /api/equipment` -- list (optional `?subcategory=` filter)
- `GET /api/equipment/subcategories`, `GET /api/equipment/:id`
- `GET /api/ingredients` -- list (optional `?subcategory=` filter)
- `GET /api/ingredients/subcategories`, `GET /api/ingredients/:id`
- `GET /api/moods`, `GET /api/moods/:id`
- `GET /api/recipes` -- paginated (`?limit=&offset=`)
- `GET /api/recipes/:id` -- with ingredients, steps, equipment
- `GET /api/recipes/:id/ratings`, `GET /api/recipes/:id/ratings/aggregate`
- `GET /`, `GET /health` -- health checks

### Auth required (Firebase token; mock user in dev)

- `POST /api/recipes/generate` -- AI-generate a recipe
- `POST /api/recipes/:id/ratings` -- submit rating (upsert)
- `DELETE /api/recipes/:recipeId/ratings/:ratingId`
- `GET/PUT /api/users/me`
- `GET/PUT /api/users/me/preferences`
- `GET /api/users/me/recipes`, `GET /api/users/me/favorites`
- `POST /api/users/me/favorites`, `DELETE /api/users/me/favorites/:recipeId`
- `GET /api/v1/users/:userId/subscriptions` -- subscription status (own user only)

## Environment Variables

Copy `.env.example` to `.env` and fill in. Required:

```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/mixr_db
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=firebase-adminsdk@your-project.iam.gserviceaccount.com
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Optional:

```bash
OPENAI_API_KEY=sk-...            # required unless using an OpenAI-compatible endpoint
LLM_STUDIO_ENDPOINT=http://localhost:1234/v1   # OpenAI-compatible endpoint (LM Studio, etc.)
REVENUECAT_API_KEY=...           # enables subscription checks; skipped when unset
PORT=6174                        # default 6174
NODE_ENV=development             # development | production | test
CORS_ORIGINS=                    # comma-separated allowlist; defaults to '*' in dev
TEST_DATABASE_URL=postgresql://localhost:5432/mixr_test   # used by test:db (localhost only)
```

## Docker

`Dockerfile` builds on `oven/bun:latest`, installs production deps (requires
`GH_PACKAGES_TOKEN` build-arg for private packages), runs as a non-root user,
exposes `6174`, and health-checks `/health`. CI/CD (`.github/workflows/ci-cd.yml`)
uses a shared reusable workflow and publishes the image to Docker Hub on `main`.

## Related Packages

- `@sudobility/mixr_types` -- shared API types (dependency)
- `@sudobility/subscription_service`, `@sudobility/types` -- subscription + common types

## License

BUSL-1.1
