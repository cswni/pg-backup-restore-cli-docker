import React from 'react'
import { NavLink } from 'react-router'
import { routes } from '../routes'
import { useAuth } from '../lib/auth'

/** Signed-in user, link to the profile page and Sign out. */
function UserFooter() {
  const { user, authDisabled, logout } = useAuth()
  if (!user) return null
  const name = user.displayName || user.username
  return (
    <div className="mb-3">
      <NavLink
        to="/profile"
        className={({ isActive }) =>
          `block rounded-lg px-2 py-1.5 -mx-2 transition-colors ${isActive ? 'bg-zinc-800' : 'hover:bg-zinc-800'}`
        }
        title="Your profile"
      >
        <p className="text-sm text-zinc-200 truncate">{name}</p>
        <p className="text-[10px] text-zinc-500 uppercase tracking-wider">
          {authDisabled ? 'auth disabled' : user.role}
        </p>
      </NavLink>
      {!authDisabled && (
        <button
          type="button"
          onClick={logout}
          className="mt-1 text-xs text-zinc-500 hover:text-zinc-200 transition-colors"
        >
          ⎋ Sign out
        </button>
      )}
    </div>
  )
}

/** Sidebar entries from the route registry. `isAdmin` hides admin-only pages. */
function navItems(isAdmin) {
  return routes
    .filter((r) => r.nav && (!r.adminOnly || isAdmin))
    .map((r) => ({ to: r.path, ...r.nav }))
}

export default function Layout({ children, isAdmin = true }) {
  const nav = navItems(isAdmin)
  return (
    <div className="flex h-screen bg-zinc-950 text-zinc-100 overflow-hidden">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 flex flex-col border-r border-zinc-800 bg-zinc-900">
        {/* Logo */}
        <div className="flex items-center gap-2.5 px-5 py-5 border-b border-zinc-800">
          <span className="text-2xl">🐘</span>
          <div>
            <p className="text-sm font-semibold text-zinc-100 leading-tight">PG Backup</p>
            <p className="text-[10px] text-zinc-500 leading-tight tracking-wider uppercase">& Restore CLI</p>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 px-3 py-4 space-y-0.5">
          {nav.map(({ to, label, icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all duration-150 ${
                  isActive
                    ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/20'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800'
                }`
              }
            >
              <span className="text-base leading-none">{icon}</span>
              {label}
            </NavLink>
          ))}
        </nav>

        {/* Footer */}
        <div className="px-5 py-4 border-t border-zinc-800">
          <UserFooter />
          <p className="text-[10px] text-zinc-600 font-mono">v1.0.0 · alpine</p>
        </div>
      </aside>

      {/* Main */}
      <main className="flex-1 overflow-y-auto">
        {children}
      </main>
    </div>
  )
}
