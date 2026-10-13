const fs = require('fs')
const path = require('path')
const { BACKUPS_DIR } = require('../config')
const catalog = require('../catalog')
const { startJob } = require('../jobs')
const config = require('./config')
const destinations = require('./destinations')
const { deleteLocation } = require('./transfer')
const { errorMessage } = require('./util')

// Retention policies: keep the last N backups and/or the backups of the
// last D days, separately for local files and for each destination.
//
// Semantics (conservative):
//   - policies apply per group = same server + container + source database
//   - a copy is deleted only when it is outside EVERY configured rule
//     (keepLast and keepDays are a union of "keep" rules)
//   - the newest copy in each scope (local / each destination) is never
//     deleted, so a group always keeps at least one copy
//   - the backup that was just created is never deleted
//   - files without a catalog row are only considered when their filename
//     prefix maps to exactly one group; anything else is left alone

const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = DAY_MS
const FIRST_SWEEP_DELAY_MS = 10 * 60 * 1000
const NAME_RE = /^(.+?)_(\d{2})-(\d{2})-(\d{4})_(\d{2})_(\d{2})_(\d{2})\./

const hasRule = (policy) => !!(policy && (policy.keepLast || policy.keepDays))

/** Prefix and timestamp encoded in pipeline file names (name_DD-MM-YYYY_HH_MM_SS.ext). */
function parseName(filename) {
  const m = NAME_RE.exec(filename)
  if (!m) return null
  const [, prefix, dd, mm, yyyy, hh, mi, ss] = m
  return { prefix, time: new Date(+yyyy, +mm - 1, +dd, +hh, +mi, +ss).getTime() }
}

const groupKey = (e) => [e.serverId || '', e.container || '', e.sourceDatabase].join('\u0000')

/**
 * Select copies to delete from `items` (newest first) under `policy`.
 * @returns {object[]} items to delete
 */
function selectForDeletion(items, policy, { now = Date.now(), protect = new Set() } = {}) {
  if (!hasRule(policy)) return []
  return items.filter((item, idx) => {
    if (idx === 0 || protect.has(item.filename)) return false
    if (policy.keepLast && idx < policy.keepLast) return false
    if (policy.keepDays && now - item.createdAt < policy.keepDays * DAY_MS) return false
    return true
  })
}

/** Uncataloged files whose prefix belongs to exactly one group. */
function adoptUncataloged(groups, cataloged) {
  const prefixGroups = new Map()
  for (const [key, members] of groups) {
    for (const m of members) {
      const parsed = parseName(m.filename)
      if (!parsed) continue
      const set = prefixGroups.get(parsed.prefix) || new Set()
      set.add(key)
      prefixGroups.set(parsed.prefix, set)
    }
  }
  const files = fs.existsSync(BACKUPS_DIR) ? fs.readdirSync(BACKUPS_DIR).filter(catalog.isBackupFile) : []
  for (const filename of files) {
    if (cataloged.has(filename)) continue
    const parsed = parseName(filename)
    const keys = parsed && prefixGroups.get(parsed.prefix)
    if (!keys || keys.size !== 1) continue
    const key = [...keys][0]
    groups.get(key).push({ filename, createdAt: parsed.time, locations: [], uncataloged: true })
  }
}

/** Build groups from the catalog (+ the in-flight backup, + matching uncataloged files). */
function buildGroups(extra) {
  const entries = catalog.listCatalogEntries().filter((e) => e.sourceDatabase)
  if (extra) entries.push(extra)
  const groups = new Map()
  for (const e of entries) {
    const key = groupKey(e)
    groups.set(key, [...(groups.get(key) || []), { ...e }])
  }
  adoptUncataloged(groups, new Set(entries.map((e) => e.filename)))
  for (const members of groups.values()) members.sort((a, b) => b.createdAt - a.createdAt)
  return groups
}

const localPath = (filename) => path.join(BACKUPS_DIR, filename)
const isLocal = (m) => fs.existsSync(localPath(m.filename))

function forgetIfGone(member) {
  if (member.virtual || member.uncataloged) return
  if (member.locations.length === 0 && !isLocal(member)) catalog.removeCatalogEntry(member.filename)
  else catalog.updateLocations(member.filename, member.locations)
}

function applyLocal(members, policy, opts, job) {
  let count = 0
  for (const m of selectForDeletion(members.filter(isLocal), policy, opts)) {
    fs.rmSync(localPath(m.filename), { force: true })
    job.log(`[retention] Deleted local file ${m.filename}${m.locations.length ? ' (remote copies kept)' : ''}`)
    forgetIfGone(m)
    count++
  }
  return count
}

async function applyDestination(dest, members, opts, job) {
  let count = 0
  const holders = members.filter((m) => m.locations.some((l) => l.destinationId === dest.id))
  for (const m of selectForDeletion(holders, dest.retention, opts)) {
    try {
      for (const loc of m.locations.filter((l) => l.destinationId === dest.id)) await deleteLocation(loc)
      m.locations = m.locations.filter((l) => l.destinationId !== dest.id)
      job.log(`[retention] Deleted ${m.filename} from ${dest.name}`)
      forgetIfGone(m)
      count++
    } catch (err) {
      job.log(`[retention] ✗ Could not delete ${m.filename} from ${dest.name}: ${errorMessage(err)}`, 'stderr')
    }
  }
  return count
}

/** True when any local or destination retention rule is configured. */
function hasAnyPolicy() {
  return hasRule(config.getLocalRetention()) || destinations.listDestinations().some((d) => hasRule(d.retention))
}

let chain = Promise.resolve()

/**
 * Apply all retention policies. Serialised so concurrent backups never
 * evaluate the same files at the same time.
 * @param {object} job
 * @param {{ current?: object }} [opts]  current = in-flight backup entry (protected)
 * @returns {Promise<number>} number of deleted copies
 */
function runRetention(job, { current } = {}) {
  const run = async () => {
    const localPolicy = config.getLocalRetention()
    const dests = destinations.listDestinations().filter((d) => d.enabled && hasRule(d.retention))
    if (!hasRule(localPolicy) && dests.length === 0) return 0
    const opts = { now: Date.now(), protect: new Set(current ? [current.filename] : []) }
    let deleted = 0
    for (const members of buildGroups(current).values()) {
      deleted += applyLocal(members, localPolicy, opts, job)
      for (const dest of dests) deleted += await applyDestination(dest, members, opts, job)
    }
    job.log(`[retention] ${deleted} cop${deleted === 1 ? 'y' : 'ies'} deleted`)
    return deleted
  }
  const result = chain.then(run, run)
  chain = result.catch(() => {})
  return result
}

/** Post-backup step (order 900): apply retention, protecting the new backup. */
async function retentionStep(ctx, job) {
  if (!hasAnyPolicy()) return ctx
  const current = {
    filename: path.basename(ctx.file),
    serverId: ctx.server?.id,
    container: ctx.container,
    sourceDatabase: ctx.database,
    createdAt: Date.now(),
    locations: ctx.locations,
    virtual: true,
  }
  try {
    await runRetention(job, { current })
  } catch (err) {
    job.log(`[retention] ✗ ${errorMessage(err)} (backup kept)`, 'stderr')
  }
  return ctx
}

/** Start a retention job (daily sweep or "run now"). Returns the job id or null. */
function startSweep(trigger, username) {
  if (!hasAnyPolicy()) return null
  return startJob('retention', { trigger }, (job) => runRetention(job), { username })
}

let timer = null

/** Daily sweep timer (unref'd so it never keeps the process alive). */
function startSweepTimer() {
  if (timer) return
  const tick = () => {
    try { startSweep('schedule') } catch (err) { console.error(`[storage] retention sweep failed: ${errorMessage(err)}`) }
  }
  timer = setTimeout(() => {
    tick()
    timer = setInterval(tick, SWEEP_INTERVAL_MS)
    timer.unref()
  }, FIRST_SWEEP_DELAY_MS)
  timer.unref()
}

module.exports = {
  runRetention, retentionStep, startSweep, startSweepTimer, selectForDeletion, parseName, hasAnyPolicy,
}
