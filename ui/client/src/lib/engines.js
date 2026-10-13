import { useEffect, useState } from 'react'
import { api } from './api'

// Engine metadata (GET /api/engines) and backup ↔ engine matching.

const ALL_OPERATIONS = ['export', 'restore', 'create', 'delete', 'unblock']
const ARCHIVE_RE = /\.archive(\.gz)?(\.enc)?$/i
const SQL_RE = /\.sql(\.gz)?(\.enc)?$/i

let cache = null

/**
 * Engines with capabilities: [{ engine, label, fileExtension, kinds, operations: { docker, direct } }].
 * Fetched once per page load.
 */
export function useEngines() {
  const [engines, setEngines] = useState(cache || [])
  useEffect(() => {
    if (cache) return
    let cancelled = false
    api.engines.list()
      .then((list) => { cache = list; if (!cancelled) setEngines(list) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return engines
}

/** Driver info for engine + server kind, with safe defaults while loading. */
export function engineInfo(engines, engine, kind) {
  const e = (engines || []).find((x) => x.engine === engine)
  return {
    operations: e?.operations?.[kind] || ALL_OPERATIONS,
    fileExtension: e?.fileExtension || (engine === 'mongodb' ? '.archive' : '.sql'),
  }
}

/**
 * Engine of a backup: the catalog's when known, else inferred from the
 * file name (.archive → mongodb). null = a .sql dump of unknown origin
 * (PostgreSQL or MySQL – the user picks a matching target).
 */
export function backupEngine(name, catalogEngine) {
  if (catalogEngine) return catalogEngine
  return ARCHIVE_RE.test(name || '') ? 'mongodb' : null
}

/** Can this backup be restored into a target running `targetEngine`? */
export function isCompatibleBackup(name, catalogEngine, targetEngine) {
  const engine = backupEngine(name, catalogEngine)
  if (engine) return engine === targetEngine
  return targetEngine !== 'mongodb' && SQL_RE.test(name || '')
}
