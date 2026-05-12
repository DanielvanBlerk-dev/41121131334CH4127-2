import jwt from 'jsonwebtoken';

/**
 * Verifies that the incoming request carries a valid admin JWT.
 * The token must be sent as:  Authorization: Bearer <token>
 *
 * Set ADMIN_JWT_SECRET in your Vercel environment variables.
 */
export function verifyAdmin(req) {
  try {
    const header = req.headers.authorization;
    if (!header) return false;

    const token = header.replace('Bearer ', '').trim();
    const secret = process.env.ADMIN_JWT_SECRET;

    if (!secret) throw new Error('ADMIN_JWT_SECRET not set');

    const decoded = jwt.verify(token, secret);
    return decoded.role === 'admin';
  } catch {
    return false;
  }
}
