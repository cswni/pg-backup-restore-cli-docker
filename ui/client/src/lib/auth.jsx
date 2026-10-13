import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { api, setUnauthorizedHandler } from './api'

const AuthContext = createContext(null)

const INITIAL = { user: null, loading: true, error: null, authDisabled: false }

/**
 * Holds the signed-in user (from GET /api/auth/me). Any 401 from the API
 * clears the user, which makes App redirect to /login.
 */
export function AuthProvider({ children }) {
  const [state, setState] = useState(INITIAL)

  const refresh = useCallback(async () => {
    try {
      const { user, authDisabled } = await api.auth.me()
      setState({ user, loading: false, error: null, authDisabled: !!authDisabled })
    } catch (e) {
      // 401 just means "not signed in"; anything else is worth showing
      setState({ ...INITIAL, loading: false, error: e.status === 401 ? null : e.message })
    }
  }, [])

  useEffect(() => {
    setUnauthorizedHandler(() => setState((s) => (s.user ? { ...s, user: null } : s)))
    refresh()
    return () => setUnauthorizedHandler(null)
  }, [refresh])

  const login = useCallback(async (username, password) => {
    const { user } = await api.auth.login(username, password)
    setState((s) => ({ ...s, user, error: null }))
    return user
  }, [])

  const logout = useCallback(async () => {
    try {
      await api.auth.logout()
    } finally {
      setState((s) => ({ ...s, user: null }))
    }
  }, [])

  /** Replace the cached user after a profile edit. */
  const setUser = useCallback((user) => setState((s) => ({ ...s, user })), [])

  const value = useMemo(() => ({
    ...state,
    isAdmin: state.user?.role === 'admin',
    refresh,
    login,
    logout,
    setUser,
  }), [state, refresh, login, logout, setUser])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

/** @returns {{ user: object|null, loading: boolean, error: string|null, authDisabled: boolean, isAdmin: boolean, refresh: Function, login: Function, logout: Function, setUser: Function }} */
export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
