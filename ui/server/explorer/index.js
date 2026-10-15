const express = require('express')
const { requireAdmin } = require('../auth')
const { httpError } = require('../validation')
const { handle } = require('../routes/util')
const { assertMongoName } = require('../drivers/mongodb-common')
const { resolveTarget, findObject, rowOptions, queryLimit } = require('./params')
const { checkConsoleSql } = require('./sql-guard')
const { parseFilter } = require('./mongodb-bson')
const { checkValues: checkMongoValues } = require('./mongodb-edit')
const { parseRowRequest, editableStructure, checkRowRequest, runRowJob, rowJobMeta } = require('./editing')

// Database Explorer API: browse tables, views and collections; admins can
// also change single rows.
//   GET    /api/explorer/objects    every signed-in role
//   GET    /api/explorer/structure  every signed-in role
//   GET    /api/explorer/rows       every signed-in role
//   POST   /api/explorer/query      admins; PostgreSQL and MySQL only, read-only
//   PATCH  /api/explorer/row        admins; one row by primary key (MongoDB: _id)
//   DELETE /api/explorer/row        admins; same
// Errors: 400 validation, 403 admin-only endpoints, 404 unknown object,
// 409 row changed or gone, 502 when the database or its client tool fails
// (with the tool's message).

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
  const ctx = resolve(req.query)
  const structure = await withSession(ctx, async (session) => {
    const object = findObject(await session.objects(), req.query)
    return editableStructure(ctx.engine, object, await session.structure(object))
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

function describeChange(op, object, request) {
  const where = object.schema ? `${object.schema}.${object.name}` : object.name
  const key = Object.entries(request.key).map(([column, value]) => `${column} = ${JSON.stringify(value)}`).join(', ')
  return op === 'update'
    ? `Updated 1 row in ${where} (${key}): ${Object.keys(request.changes).join(', ')}`
    : `Deleted 1 row from ${where} (${key})`
}

/**
 * PATCH / DELETE /explorer/row: checks against the catalog, then the change
 * runs as an audit job and the response waits for it.
 * @param {'update'|'delete'} op
 */
function rowChangeRoute(op) {
  return handle(async (req, res) => {
    const body = req.body ?? {}
    const ctx = resolve(body)
    const parsed = parseRowRequest(body, op)
    const jobId = await withSession(ctx, async (session) => {
      const object = findObject(await session.objects(), body)
      const structure = await session.structure(object)
      const request = checkRowRequest(parsed, editableStructure(ctx.engine, object, structure), ctx.engine)
      if (ctx.engine === 'mongodb') checkMongoValues(request)
      const job = { type: `explorer-${op}`, meta: rowJobMeta(ctx, object, request), username: req.user?.username, describe: describeChange(op, object, request) }
      return runRowJob(job, () => (op === 'update'
        ? session.updateRow(object, structure, request)
        : session.deleteRow(object, structure, request)))
    })
    res.json({ ok: true, jobId })
  })
}

router.patch('/explorer/row', requireAdmin, rowChangeRoute('update'))
router.delete('/explorer/row', requireAdmin, rowChangeRoute('delete'))

module.exports = { router }
