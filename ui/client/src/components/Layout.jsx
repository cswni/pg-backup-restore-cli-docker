import React, { useEffect, useRef, useState } from 'react'
import { NavLink, useLocation } from 'react-router'
import { LogOut, Menu, X } from 'lucide-react'
import { routes } from '../routes'
import { useAuth } from '../lib/auth'
import { api } from '../lib/api'
import { useDialogFocus } from '../hooks/useDialogFocus'
import { Brand } from './UI'

const MOBILE_NAV_ID = 'mobile-nav'

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
        <p className="text-[10px] text-zinc-400 uppercase tracking-wider">
          {authDisabled ? 'auth disabled' : user.role}
        </p>
      </NavLink>
      {!authDisabled && (
        <button
          type="button"
          onClick={logout}
          className="min-h-[44px] -mx-2 px-2 inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-zinc-100 transition-colors"
        >
          <LogOut aria-hidden="true" className="size-4" /> Sign out
        </button>
      )}
    </div>
  )
}

/** App version from the public health check; nothing while unknown. */
function useAppVersion() {
  const [version, setVersion] = useState(null)
  useEffect(() => {
    let cancelled = false
    api.monitoring.health()
      .then((h) => { if (!cancelled) setVersion(h.version || null) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])
  return version
}

/** Sidebar entries from the route registry. `isAdmin` hides admin-only pages. */
function navItems(isAdmin) {
  return routes
    .filter((r) => r.nav && (!r.adminOnly || isAdmin))
    .map((r) => ({ to: r.path, ...r.nav }))
}

/** Brand, navigation and user footer; shared by the desktop sidebar and the mobile drawer. */
function SidebarContent({ isAdmin, version, header }) {
  const nav = navItems(isAdmin)
  return (
    <>
      <div className="flex items-center gap-2 px-5 py-4 border-b border-zinc-800">
        <Brand />
        {header}
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-4 space-y-0.5">
        {nav.map(({ to, label, icon: Glyph }) => (
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
            <Glyph aria-hidden="true" className="size-4 shrink-0" />
            {label}
          </NavLink>
        ))}
      </nav>

      <div className="px-5 py-4 border-t border-zinc-800">
        <UserFooter />
        {version && <p className="text-[10px] text-zinc-400 font-mono">v{version}</p>}
      </div>
    </>
  )
}

/** Below md: the same navigation as a modal drawer. Escape or the close button dismisses it. */
function MobileDrawer({ isAdmin, version, onClose }) {
  const ref = useRef(null)
  useDialogFocus(ref, onClose)
  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      aria-label="Close menu"
      data-dialog-close
      className="ml-auto shrink-0 min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center rounded-lg text-xl leading-none text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800"
    >
      <X aria-hidden="true" className="size-5" />
    </button>
  )
  return (
    <div className="md:hidden fixed inset-0 z-40 flex">
      <div className="absolute inset-0 bg-black/70" onClick={onClose} aria-hidden="true" />
      <div
        ref={ref}
        id={MOBILE_NAV_ID}
        role="dialog"
        aria-modal="true"
        aria-label="Menu"
        tabIndex={-1}
        className="relative w-64 max-w-[85vw] h-full flex flex-col bg-zinc-900 border-r border-zinc-800 outline-hidden"
      >
        <SidebarContent isAdmin={isAdmin} version={version} header={closeButton} />
      </div>
    </div>
  )
}

export default function Layout({ children, isAdmin = true }) {
  const version = useAppVersion()
  const [menuOpen, setMenuOpen] = useState(false)
  const { pathname } = useLocation()

  useEffect(() => { setMenuOpen(false) }, [pathname])

  return (
    <div className="flex h-dvh bg-zinc-950 text-zinc-100 overflow-hidden">
      <aside className="hidden md:flex w-56 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900">
        <SidebarContent isAdmin={isAdmin} version={version} />
      </aside>

      <div className="flex-1 min-w-0 flex flex-col">
        <header className="md:hidden shrink-0 flex items-center justify-between gap-3 px-4 py-1 border-b border-zinc-800 bg-zinc-900">
          <Brand />
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            aria-expanded={menuOpen}
            aria-controls={MOBILE_NAV_ID}
            className="min-h-[44px] -mr-2 px-3 inline-flex items-center gap-2 rounded-lg text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800"
          >
            <Menu aria-hidden="true" className="size-5" /> Menu
          </button>
        </header>
        <main className="flex-1 min-h-0 overflow-y-auto">
          {children}
        </main>
      </div>

      {menuOpen && <MobileDrawer isAdmin={isAdmin} version={version} onClose={() => setMenuOpen(false)} />}
    </div>
  )
}
