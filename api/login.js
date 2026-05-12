import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

/**
 * POST /api/login
 * Body: { password: string }
 *
 * Required Vercel env vars:
 *   ADMIN_PASSWORD_HASH  — bcrypt hash of your admin password
 *                          Generate with: node -e "require('bcryptjs').hash('yourpassword',12).then(console.log)"
 *   ADMIN_JWT_SECRET     — any long random string (e.g. from `openssl rand -hex 32`)
 *
 * Returns: { token } on success — store this in sessionStorage and send as
 *          Authorization: Bearer <token> on all admin API calls.
 */
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { password } = req.body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'Missing password' });
  }

  const hash      = process.env.ADMIN_PASSWORD_HASH;
  const jwtSecret = process.env.ADMIN_JWT_SECRET;

  if (!hash || !jwtSecret) {
    console.error('ADMIN_PASSWORD_HASH or ADMIN_JWT_SECRET not configured');
    return res.status(500).json({ error: 'Server misconfigured' });
  }

  const valid = await bcrypt.compare(password, hash);
  if (!valid) {
    // Constant-time rejection prevents timing attacks
    return res.status(401).json({ error: 'Invalid password' });
  }

  const token = jwt.sign(
    { role: 'admin' },
    jwtSecret,
    { expiresIn: '12h' }
  );

  return res.status(200).json({ token });
}
