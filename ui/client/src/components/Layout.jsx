import React from 'react'
import { NavLink } from 'react-router'
import { routes } from '../routes'

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
