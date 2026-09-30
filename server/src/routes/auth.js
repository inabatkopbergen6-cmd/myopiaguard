import express from 'express';
import {
  SUPPORTED_LANGUAGES,
  accessibleClassrooms,
  authenticate,
  login,
  publicUser,
  requireUser,
  savePreferences,
} from '../auth.js';
import config from '../config.js';
import { ApiError, handler } from '../lib/http.js';
import { all, get, run } from '../db.js';
import { now } from '../lib/time.js';

const router = express.Router();

router.post(
  '/login',
  handler((req, res) => {
    const { username, password } = req.body ?? {};
    const { token, user } = login(username, password);
    res.json({ token, user, classrooms: user.role === 'teacher' ? accessibleClassrooms({ ...user, userId: user.id }) : [] });
  }),
);

/**
 * Demo convenience: the seeded accounts, so a reviewer can sign in without
 * guessing. Public by necessity (it is read from the sign-in page, before there is
 * a session) and therefore gated on demo mode, so a real deployment cannot be
 * enumerated for usernames.
 */
router.get(
  '/demo-accounts',
  handler((req, res) => {
    if (!config.demoMode && process.env.MG_ALLOW_DEMO_TOOLS !== '1') {
      return res.json({ accounts: [], note: 'Account listing is only available in demo mode.' });
    }
    const rows = all(`SELECT username, role, display_name, title FROM users ORDER BY role DESC, username`, []);
    return res.json({
      accounts: rows.map((row) => ({
        username: row.username,
        role: row.role,
        displayName: row.display_name,
        title: row.title,
      })),
      note: 'Seeded teaching accounts. The password is set by the seed script.',
    });
  }),
);

router.use(authenticate);

router.get(
  '/me',
  requireUser(),
  handler((req, res) => {
    res.json({
      user: {
        id: req.auth.userId,
        role: req.auth.role,
        displayName: req.auth.displayName,
        schoolId: req.auth.schoolId,
        preferences: req.auth.preferences ?? {},
      },
      classrooms: req.auth.role === 'teacher' ? accessibleClassrooms(req.auth) : [],
      serverTime: now(),
    });
  }),
);

/**
 * Saves per-account interface preferences.
 *
 * Only the language exists today, and it is validated against the supported list
 * rather than stored blindly — an unknown code would otherwise sit in the profile
 * and silently fall back to the default on every future sign-in.
 */
router.patch(
  '/me/preferences',
  requireUser(),
  handler((req, res) => {
    const body = req.body ?? {};
    const patch = {};
    if (body.language !== undefined) {
      const language = String(body.language).toLowerCase();
      if (!SUPPORTED_LANGUAGES.includes(language)) {
        throw new ApiError(400, 'invalid_value', { field: 'language', allowed: SUPPORTED_LANGUAGES });
      }
      patch.language = language;
    }
    if (Object.keys(patch).length === 0) {
      throw new ApiError(400, 'nothing_to_update', { allowed: ['language'] });
    }
    res.json({ preferences: savePreferences(req.auth.userId, patch) });
  }),
);

router.post(
  '/logout',
  requireUser(),
  handler((req, res) => {
    run('DELETE FROM auth_tokens WHERE token = ?', [req.auth.token]);
    res.json({ ok: true });
  }),
);

router.get(
  '/users',
  requireUser('admin'),
  handler((req, res) => {
    const rows = all('SELECT id, role, display_name, title, username FROM users WHERE school_id = ?', [
      req.auth.schoolId,
    ]);
    res.json({ users: rows.map(publicUser) });
  }),
);

export default router;

export function userCount() {
  return Number(get('SELECT COUNT(*) AS count FROM users')?.count ?? 0);
}
