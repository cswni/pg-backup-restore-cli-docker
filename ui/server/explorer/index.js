const express = require('express')
const { requireAdmin } = require('../auth')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const { assertMongoName } = require('../drivers/mongodb-common')
const { resolveTarget, findObject, rowOptions, queryLimit } = require('./params')
const { checkConsoleSql } = require('./sql-guard')
const { parseFilter } = require('./mongodb-bson')

// Database Explorer API: browse tables, views and collections, read-only.
//   GET  /api/explorer/objects    every signed-in role
//   GET  /api/explorer/structure  every signed-in role
//   GET  /api/explorer/rows       every signed-in role
//   POST /api/explorer/query      admins; PostgreSQL and MySQL only
// Errors: 400 validation, 403 console for non-admins, 404 unknown object,
// 502 when the database or its client tool fails (with the tool's message).

const MAX_ERROR_LENGTH = 2000

const router = express.Router()

function resolve(params) {
  const ctx = resolveTarget(params)
  if (ctx.engine === 'mongodb') {
    try {
      assertMongoName(ctx.database)
    } catch (err) {
      throw httpError(400, err.message)
    }
  }
  return ctx
}

/** Run `fn(session, ctx)` on one connection; tool failures become 502. */
async function withSession(ctx, fn) {
  try {
    return await ctx.adapter.open(ctx.target, ctx.database, (session) => fn(session, ctx))
  } catch (err) {
    if (err.status) throw err
    throw httpError(502, String(err.message || err).trim().slice(0, MAX_ERROR_LENGTH))
  }
}

router.get('/explorer/objects', handle(async (req, res) => {
  const objects = await withSession(resolve(req.query), (session) => session.objects())
  res.json({ objects })
}))

router.get('/explorer/structure', handle(async (req, res) => {
  const structure = await withSession(resolve(req.query), async (session) => {
    const object = findObject(await session.objects(), req.query)
    return session.structure(object)
  })
  res.json(structure)
}))

router.get('/explorer/rows', handle(async (req, res) => {
  const ctx = resolve(req.query)
  const opts = rowOptions(req.query, ctx.engine)
  if (ctx.engine === 'mongodb') parseFilter(opts.filter)
  const page = await withSession(ctx, async (session) => {
    const object = findObject(await session.objects(), req.query)
    // SQL engines need the column list to build the query; MongoDB only to check `sort`
    const structure = ctx.engine !== 'mongodb' || opts.sort ? await session.structure(object) : null
    if (opts.sort && !structure.columns.some((c) => c.name === opts.sort)) {
      throw httpError(400, `Cannot sort by ${opts.sort}: no such column`)
    }
    return session.rows(object, { ...opts, structure })
  })
  const hasMore = page.rows.length > opts.limit
  const rows = page.rows.slice(0, opts.limit)
  const total = hasMore || (rows.length === 0 && opts.offset > 0) ? null : opts.offset + rows.length
  res.json({ columns: page.columns, rows, offset: opts.offset, limit: opts.limit, hasMore, total })
}))

router.post('/explorer/query', requireAdmin, handle(async (req, res) => {
  const body = req.body ?? {}
  const limit = queryLimit(body.limit)
  const ctx = resolve(body)
  if (!ctx.adapter.supportsQuery) throw httpError(400, 'The SQL console is available for PostgreSQL and MySQL only')
  const sql = checkConsoleSql(body.sql, ctx.engine)
  const started = Date.now()
  const result = await withSession(ctx, (session) => session.query(sql, limit))
  res.json({
    columns: result.columns,
    rows: result.rows.slice(0, limit),
    truncated: result.rows.length > limit,
    durationMs: Date.now() - started,
  })
}))

module.exports = { router }
