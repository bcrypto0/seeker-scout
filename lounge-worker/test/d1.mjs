// lounge-worker/test/d1.mjs
// In-memory D1 stand-in over node:sqlite (Node 24). Same SQL dialect as D1, never production.
// Counts queries the way D1 does (every statement, including each one inside batch()).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';

export function makeD1(sqlFiles, { failWhen = null } = {}) {
  const db = new DatabaseSync(':memory:');
  for (const f of sqlFiles) db.exec(readFileSync(f, 'utf8'));
  const stats = { queries: 0 };
  const guard = (sql) => { stats.queries++; if (failWhen && failWhen(sql)) throw new Error('D1_ERROR: injected'); };
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => { guard(sql); const r = db.prepare(sql).get(...args); return r === undefined ? null : { ...r }; },
    all: async () => { guard(sql); return { results: db.prepare(sql).all(...args).map((r) => ({ ...r })), success: true }; },
    run: async () => { guard(sql); const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec('BEGIN');
      try { const out = []; for (const s of stmts) out.push(await s.run()); db.exec('COMMIT'); return out; }
      catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    stats,
    raw: db,
  };
}
