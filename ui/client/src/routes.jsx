import Dashboard from './pages/Dashboard'
import Containers from './pages/Containers'
import ContainerDetail from './pages/ContainerDetail'
import Backups from './pages/Backups'
import JobLog from './pages/JobLog'
import Users from './pages/Users'
import Profile from './pages/Profile'
import Servers from './pages/Servers'
import ServerDatabases from './pages/ServerDatabases'
import Schedules from './pages/Schedules'
import Jobs from './pages/Jobs'
import Notifications from './pages/Notifications'
import StorageSettings from './pages/StorageSettings'

// Page registry used by App (routes) and Layout (sidebar).
//   path:      react-router path
//   element:   page component instance
//   nav:       { label, icon } to show in the sidebar (omit for detail pages)
//   adminOnly: hide from non-admin users (the API enforces it too)
//
// To add a page, import it and add one entry.
export const routes = [
  { path: '/', element: <Dashboard />, nav: { label: 'Dashboard', icon: '⬛' } },
  { path: '/containers', element: <Containers />, nav: { label: 'Containers', icon: '🐳' } },
  { path: '/containers/:name', element: <ContainerDetail /> },
  { path: '/servers', element: <Servers />, nav: { label: 'Servers', icon: '🖧' } },
  { path: '/servers/:id/databases', element: <ServerDatabases /> },
  { path: '/backups', element: <Backups />, nav: { label: 'Backups', icon: '🗄️' } },
  { path: '/schedules', element: <Schedules />, nav: { label: 'Schedules', icon: '⏰' } },
  { path: '/jobs', element: <Jobs />, nav: { label: 'Jobs', icon: '📋' } },
  { path: '/jobs/:jobId', element: <JobLog /> },
  { path: '/settings/notifications', element: <Notifications />, nav: { label: 'Notifications', icon: '🔔' }, adminOnly: true },
  { path: '/settings/storage', element: <StorageSettings />, nav: { label: 'Storage', icon: '☁️' }, adminOnly: true },
  { path: '/users', element: <Users />, nav: { label: 'Users', icon: '👥' }, adminOnly: true },
  { path: '/profile', element: <Profile /> },
]
