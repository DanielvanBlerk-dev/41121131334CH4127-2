import bcrypt from 'bcryptjs';

/**
 * GET /api/debug-auth?password=YourPassword
 * TEMPORARY — delete this file once login is working.
 */
export default async function handler(req, res) {
  const hash     = process.env.ADMIN_PASSWORD_HASH;
  const password = req.query.password;

  if (!hash) {
    return res.status(200).json({ error: 'ADMIN_PASSWORD_HASH env var is not set' });
  }

  if (!password) {
    return res.status(200).json({
      hashPresent: true,
      hashLength:  hash.length,
      hashPreview: hash.slice(0, 7) + '...',
      note:        'Add ?password=YourPassword to test the compare',
    });
  }

  const match = await bcrypt.compare(password, hash);
  return res.status(200).json({
    hashPresent:   true,
    hashLength:    hash.length,
    hashPreview:   hash.slice(0, 7) + '...',
    passwordMatch: match,
  });
}
