import { useCallback } from 'react'
import { useSearchParams } from 'react-router'

// The explorer's whole selection lives in the query string, so a link opens
// the same server, container, database and object, and back/forward step
// through what was browsed:
//   /explorer?server=&container=&engine=&database=&schema=&object=&tab=
const KEYS = ['server', 'container', 'engine', 'database', 'schema', 'object', 'tab']

// Picking a level clears everything below it.
const CLEARS = {
  server: ['container', 'engine', 'database', 'schema', 'object', 'tab'],
  container: ['database', 'schema', 'object', 'tab'],
  database: ['schema', 'object', 'tab'],
  object: ['tab'],
}

export const TABS = ['data', 'structure', 'query']

/** Link to the explorer for a target, e.g. from a database row. */
export function explorerHref({ serverId, container, engine, database }) {
  const params = new URLSearchParams()
  if (serverId && serverId !== 'local') params.set('server', serverId)
  if (container) params.set('container', container)
  if (engine) params.set('engine', engine)
  if (database) params.set('database', database)
  const query = params.toString()
  return `/explorer${query ? `?${query}` : ''}`
}

/**
 * @returns {{ target: { serverId: string, container: string, engine: string, database: string, schema: string, object: string, tab: string },
 *   select: (changes: object) => void }}
 */
export function useExplorerTarget() {
  const [params, setParams] = useSearchParams()

  const target = {
    serverId: params.get('server') || 'local',
    container: params.get('container') || '',
    engine: params.get('engine') || '',
    database: params.get('database') || '',
    schema: params.get('schema') || '',
    object: params.get('object') || '',
    tab: TABS.includes(params.get('tab')) ? params.get('tab') : 'data',
  }

  /**
   * Apply changes ({ server, container, engine, database, schema, object, tab };
   * '' or null removes a key). Each change is a history entry, except tab
   * switches and `replace: true`.
   */
  const select = useCallback((changes, { replace } = {}) => {
    setParams((current) => {
      const next = new URLSearchParams(current)
      for (const key of Object.keys(changes)) {
        for (const cleared of CLEARS[key] || []) {
          if (!(cleared in changes)) next.delete(cleared)
        }
      }
      for (const [key, value] of Object.entries(changes)) {
        if (!KEYS.includes(key)) continue
        if (value == null || value === '' || (key === 'server' && value === 'local') || (key === 'tab' && value === 'data')) {
          next.delete(key)
        } else {
          next.set(key, value)
        }
      }
      return next
    }, { replace: replace ?? Object.keys(changes).every((k) => k === 'tab') })
  }, [setParams])

  return { target, select }
}
