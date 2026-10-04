/**
 * Seed/demo constants, deliberately in a module of their own.
 *
 * These two values are shared by the seed script (which writes them) and the auth
 * route (which reports the password so the sign-in page can display it). Importing
 * them from `seed.js` would create a cycle — `seed.js` imports `auth.js`, and
 * `auth.js` is what `routes/auth.js` already depends on — so the constants live in
 * this leaf module instead: no imports, no side effects, safe for anyone to read.
 *
 * `DEMO_PASSWORD` is the single source of truth for the demo credential. It is the
 * value the seed hashes into every account and the value the sign-in page shows,
 * so those two can never disagree.
 */

export const DEMO_PASSWORD = 'myopiaguard';

export const DEMO_CLASSROOM_NAME = 'Room 208 — Computer Science';

export default { DEMO_PASSWORD, DEMO_CLASSROOM_NAME };
