import { Redis } from '@upstash/redis';

const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const LOG_KEY     = 'audit:log';
const MAX_ENTRIES = 500;   // keep the last 500 log entries in Redis

/**
 * Appends a structured audit log entry to Redis.
 *
 * @param {object} entry
 * @param {string} entry.action   - e.g. 'login_success', 'login_failed', 'add_painting', 'delete_painting', 'toggle_sold'
 * @param {string} entry.ip       - client IP
 * @param {object} [entry.detail] - any extra context (painting id, title, etc.)
 */
export async function auditLog({ action, ip, detail = {} }) {
  try {
    const entry = {
      ts:     new Date().toISOString(),
      action,
      ip,
      detail,
    };

    // Prepend to list so newest entries are first
    await redis.lpush(LOG_KEY, JSON.stringify(entry));

    // Trim to MAX_ENTRIES so the list never grows unbounded
    await redis.ltrim(LOG_KEY, 0, MAX_ENTRIES - 1);
  } catch (err) {
    // Logging must never crash the main request
    console.error('auditLog error:', err);
  }
}

/**
 * GET /api/audit-log (admin only — see audit-log.js)
 * Returns the most recent `limit` log entries.
 */
export async function getAuditLog(limit = 100) {
  try {
    const raw = await redis.lrange(LOG_KEY, 0, limit - 1);
    return raw.map(entry => {
      try { return JSON.parse(entry); }
      catch { return { raw: entry }; }
    });
  } catch (err) {
    console.error('getAuditLog error:', err);
    return [];
  }
}
