# Supabase setup for GymOP

This change adds a Supabase-backed implementation to the existing storage layer. The existing API routes and spreadsheet validation remain in place.

## 1. Create the database schema

1. Open the GymOP project in the Supabase dashboard.
2. Open **SQL Editor** and create a new query.
3. Copy the contents of `supabase/schema.sql` into the query.
4. Run it. It creates:
   - `gymop_weekly_uploads` for weekly uploads (one record per gym and week)
   - `gymop_gym_settings` for limits, floor-plan placements, and activity events
   - A private `gymop-floor-plans` Storage bucket for sanitized floor-plan PNGs

## 2. Configure local environment variables

At the project root (beside `package.json`), create `.env.local`:

```env
SUPABASE_URL=https://YOUR_PROJECT_REF.supabase.co
SUPABASE_SECRET_KEY=sb_secret_REPLACE_WITH_YOUR_SECRET_KEY
```

Find the Project URL and Secret key in the Supabase project dashboard. The Project URL is the base URL, not the `/rest/v1/` URL.

**Do not use the publishable key as `SUPABASE_SECRET_KEY`.** The server-side storage adapter needs a secret key. Never prefix it with `NEXT_PUBLIC_`, paste it into source code, commit `.env.local`, or put it in browser code. The existing `.gitignore` already ignores `.env*`.

For deployment, add the same two variables in the hosting provider's server-side environment settings.

## 3. Install dependencies

The project now declares `@supabase/supabase-js`. Run:

```bash
npm install
```

This also updates `package-lock.json`. (If using `npm ci`, first regenerate and commit the lockfile with `npm install`.)

## 4. What changed

`lib/storage.ts` now selects storage in this order:

1. Supabase, when `SUPABASE_URL` and `SUPABASE_SECRET_KEY` (or the legacy `SUPABASE_SERVICE_ROLE_KEY`) are present.
2. Existing Vercel Blob storage, when `BLOB_READ_WRITE_TOKEN` is present.
3. Existing local `.gymop-data` file storage during local development.

The existing API routes continue to call the same storage functions. Spreadsheet parsing and validation in `lib/story1.ts` were not changed.

## 5. Verify persistence

After the schema is installed and environment variables are configured:

1. Start the project with `npm run dev`.
2. Upload a valid test CSV for a test gym.
3. Confirm a row appears in Supabase **Table Editor → gymop_weekly_uploads**.
4. Refresh the page and load the saved upload list.
5. Confirm the data remains available.
6. Test a limit change and floor-plan upload; confirm the settings row and private Storage object appear.

Use fake/sample gym data for this test.

## Important security limitation — do not use with real gym data yet

This is a persistence integration, **not a completed authentication system**.

The current application accepts `gymName` from the browser, and the API routes do not yet establish a verified manager identity. The Supabase server secret bypasses Row Level Security by design. Therefore, anyone who can reach the current API routes may be able to request another gym name's data. Enabling RLS alone does not fix that while the server uses the secret key.

Before deploying with real or confidential gym data, implement authenticated manager sessions and derive the gym identifier from the verified server-side session (never from the request body/query string), then enforce gym-level authorization. This is the separate password/authentication priority.

The SQL enables RLS and creates no anon/authenticated policies as a protective default, but server operations using the secret key bypass those policies. Keep the secret key server-only.
