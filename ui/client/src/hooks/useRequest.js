import { useCallback, useEffect, useRef, useState } from 'react'

const IDLE = { data: null, loading: false, error: null }

/**
 * Like useFetch, but skips the request while `fetcher` is null and ignores
 * responses that arrive after the inputs changed (fast clicks through pages
 * or objects never show stale rows).
 * @param {(() => Promise<any>) | null} fetcher
 * @param {Array} deps  re-run when these change
 * @returns {{ data: any, loading: boolean, error: string|null, reload: () => void }}
 */
export function useRequest(fetcher, deps) {
  const [state, setState] = useState(fetcher ? { ...IDLE, loading: true } : IDLE)
  const latest = useRef(0)

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fetcher ? fetcher : () => null, deps)
  const enabled = Boolean(fetcher)

  const load = useCallback(async () => {
    const ticket = ++latest.current
    if (!enabled) {
      setState(IDLE)
      return
    }
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const data = await run()
      if (ticket === latest.current) setState({ data, loading: false, error: null })
    } catch (e) {
      if (ticket === latest.current) setState({ data: null, loading: false, error: e.message || 'Request failed' })
    }
  }, [run, enabled])

  useEffect(() => { load() }, [load])

  return { ...state, reload: load }
}
