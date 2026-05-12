import jwt from 'jsonwebtoken';

/**
 * Verifies that the incoming request carries a valid admin JWT.
 * Token must be sent as:  Authorization: Bearer <token>
 *
 * Returns the decoded payload { role, iat, exp } on success, or null on failure.
 * Callers should treat null as unauthorised.
 */
export function verifyAdmin(req) {
  try {
    const header = req.headers.authorization;
    if (!header) return null;

    const token  = header.replace('Bearer ', '').trim();
    const secret = process.env.ADMIN_JWT_SECRET;
    if (!secret) throw new Error('ADMIN_JWT_SECRET not set');

    const decoded = jwt.verify(token, secret);
    if (decoded.role !== 'admin') return null;

    return decoded;
  } catch {
    return null;
  }
}
