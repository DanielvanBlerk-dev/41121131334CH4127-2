import { verifyAdmin } from './_verifyAdmin.js';
import { getAuditLog } from './_auditLog.js';

/**
 * GET /api/audit-log
 * Admin only. Returns the last 100 audit log entries.
 * Query param: ?limit=N (max 500)
 *
 * Example response:
 * [
 *   { ts: "2026-05-13T10:00:00.000Z", action: "login_success", ip: "1.2.3.4", detail: {} },
 *   { ts: "2026-05-13T09:58:00.000Z", action: "delete_painting", ip: "1.2.3.4", detail: { id: 1, title: "Still Life" } },
 *   ...
 * ]
 */
export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const admin = verifyAdmin(req);
  if (!admin) return res.status(401).json({ error: 'Unauthorized' });

  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const entries = await getAuditLog(limit);

  return res.status(200).json({ entries });
}
