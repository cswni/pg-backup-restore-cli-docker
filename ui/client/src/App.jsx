import React from 'react'
import { Routes, Route, Navigate, useLocation } from 'react-router'
import Layout from './components/Layout'
import { Spinner, ErrorAlert } from './components/UI'
import { AuthProvider, useAuth } from './lib/auth'
import Login from './pages/Login'
import { routes } from './routes'

function FullScreen({ children }) {
  return <div className="min-h-dvh flex items-center justify-center bg-zinc-950 p-4">{children}</div>
}

/** Signed out: only /login exists; everything else redirects there (remembering where to return). */
function SignedOutRoutes() {
  const location = useLocation()
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="*" element={<Navigate to="/login" replace state={{ from: location }} />} />
    </Routes>
  )
}

function SignedInRoutes({ isAdmin }) {
  const location = useLocation()
  const returnTo = location.state?.from?.pathname || '/'
  const visible = routes.filter((r) => !r.adminOnly || isAdmin)
  return (
    <Layout isAdmin={isAdmin}>
      <Routes>
        {visible.map(({ path, element }) => (
          <Route key={path} path={path} element={element} />
        ))}
        <Route path="/login" element={<Navigate to={returnTo} replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}

function Shell() {
  const { user, loading, error, isAdmin, refresh } = useAuth()

  if (loading) return <FullScreen><Spinner /></FullScreen>
  if (error) {
    return <FullScreen><div className="w-full max-w-md"><ErrorAlert message={error} onRetry={refresh} /></div></FullScreen>
  }
  if (!user) return <SignedOutRoutes />
  return <SignedInRoutes isAdmin={isAdmin} />
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
