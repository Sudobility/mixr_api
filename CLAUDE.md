# MIXR API

> **Git policy — never auto-commit or auto-push.** Leave your work in the working tree.
> Run `git commit`, `git push`, `gh pr create`, or `scripts/push_all.sh` **only when the user
> explicitly asks in that turn**. Approval for an earlier change does not carry forward, and
> finishing a task is not permission to commit it. Stay on the current branch; do not create
> feature branches for code changes.

Backend API for MIXR -- AI-powered cocktail recipe generation. Takes a user's equipment,
ingredients, and mood; generates a recipe via an LLM; persists recipes, ratings, favorites.

## Stack

- **TypeScript on Bun** (ESM). Package manager is **Bun only** — never npm/yarn/pnpm.
- **Hono** web framework; **Drizzle ORM** on **PostgreSQL** (schema `mixr`).
- **Firebase Admin** auth; **OpenAI**-compatible LLM; **Zod** validation.
- Private `@sudobility/*` deps come from GitHub Packages (`.npmrc`); `bun install` needs a
  GitHub token with `read:packages`.

## Commands

```bash
bun run dev          # dev server, hot reload, port 6174
bun run start        # run from src; build / start:prod for the bundled dist/
bun run test:unit    # unit tests (vitest) — THIS is CI's test run. (`bun run test` does NOT exist)
bun run test:db      # DB + integration suites; manual only, needs external services (see Testing)
bun run lint         # eslint src
bun run typecheck    # tsc --noEmit
bun run format       # prettier --write src
bun run db:generate  # generate migrations from schema
bun run db:migrate   # apply migrations (src/db/migrate.ts)
bun run db:seed      # seed equipment (26), ingredients (91), moods (8)
bun run db:studio    # Drizzle Studio
```

## Layout

```
src/
├── index.ts                  # Hono app, middleware chain, route mounting, server export
├── config/
│   ├── env.ts                # env loading + Zod validation (see gotchas)
│   └── firebase.ts           # Firebase Admin init; exports isFirebaseEnabled
├── db/
│   ├── index.ts              # Drizzle instance + postgres connection
│   ├── schema.ts             # 11 tables (mixr schema) + relations
│   ├── migrate.ts, seed.ts
├── middleware/
│   ├── auth.ts               # requireAuth / optionalAuth (dev mock user: dev-user-123)
│   ├── errorHandler.ts       # global onError handler
│   └── subscription.ts       # RevenueCat helper (null when REVENUECAT_API_KEY unset)
├── routes/                   # equipment, ingredients, moods, recipes, users, subscriptions
├── services/
│   ├── recipeGenerator.ts    # OpenAI/LM Studio call (gpt-4, or qwen-32b-everything on LM Studio)
│   └── recipeParser.ts       # pure: buildRecipePrompt, parseRecipeResponse, extractJson
└── validation/schemas.ts     # Zod request schemas
tests/unit/                   # errorHandler, recipeGenerator, validation, placeholder (4 files, 55 tests)
drizzle/migrations/           # generated SQL
```

Shared/response types come from `@sudobility/mixr_types` (there is no local `src/types`).

## Architecture notes

- Middleware chain (`src/index.ts`): `logger()` → `prettyJSON()` → `cors()` → `onError(errorHandler)`
  → routes. CORS origin is `CORS_ORIGINS` split on commas, else `'*'`.
- Routes are per-file Hono sub-apps mounted under `/api/*`. **Subscriptions mount at
  `/api/v1/users`** (note the `v1`), everything else under `/api/<name>`.
- Response shape: `{ success, data?, error?, count? }`.
- Auth: `requireAuth` sets `c.get('user')` (`AuthUser` = uid/email/emailVerified). **When Firebase
  is not configured (`isFirebaseEnabled` false), auth is bypassed with a mock user `dev-user-123`** —
  so protected routes work locally with no token. In `users.ts`, auth is applied via
  `app.use('/me/*', requireAuth)`, not inline per route.
- LLM: if `LLM_STUDIO_ENDPOINT` is set, the OpenAI client points there with a dummy key and model
  `qwen-32b-everything`; otherwise it uses `OPENAI_API_KEY` and `gpt-4`.

## Database

PostgreSQL, schema `mixr`. 11 tables: `equipment`, `ingredients`, `moods`, `users`
(PK = Firebase UID), `user_preferences` (equipment/ingredient id arrays), `recipes`,
`recipe_ingredients`, `recipe_steps`, `recipe_equipment` (joins), `recipe_ratings`
(1–5 stars, unique per user+recipe), `user_favorites`. See `src/db/schema.ts`.

## Environment

Required: `DATABASE_URL`, `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`.
Optional: `OPENAI_API_KEY`, `LLM_STUDIO_ENDPOINT`, `REVENUECAT_API_KEY`, `PORT` (6174),
`NODE_ENV`, `CORS_ORIGINS`, `TEST_DATABASE_URL`. Copy `.env.example` → `.env`. Full list in README.

**Load priority is `process.env` > `.env.local` > `.env`** (environment wins over files). It used
to be reversed, which let a committed file silently override an exported variable and defeated the
test DB guard (the guard sets `DATABASE_URL` in `process.env`, which `.env` then replaced). Do not
flip it back. `src/config/env.ts` derives its root from `import.meta.url`, not `import.meta.dir`:
the latter is Bun-only and is `undefined` under Node, which is what vitest runs on.

## Testing

- **One runner, two configs.** `bun run test:unit` (`vitest.config.ts`) excludes `**/*.db.test.ts`
  (4 files, 55 tests), never touches a database; this is what CI runs. `bun run test:db`
  (`vitest.db.config.ts`) collects only `*.db.test.ts` and is **manual, never run in CI**.
- **`TEST_DATABASE_URL`, not `DATABASE_URL`.** `tests/setup.db.ts` requires host be exactly
  `localhost` (`127.0.0.1` refused). `tests/setup.ts` deletes `DATABASE_URL` outright.
- **The db suite needs external services.** `src/integration.db.test.ts` expects the API on
  `:6174` — use `./run-integration-tests.sh`, which starts one — and `src/llm-studio.db.test.ts`
  expects LM Studio on `:1234`. Failures without those are environmental, not regressions.

## Docker / CI

`Dockerfile` (`oven/bun:latest`, non-root, port 6174, `/health` healthcheck) needs the
`GH_PACKAGES_TOKEN` build-arg for private packages. `.github/workflows/ci-cd.yml` delegates to a
shared reusable workflow: tests on `develop`, Docker Hub publish on `main` (npm publish skipped).
