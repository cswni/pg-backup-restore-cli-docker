import React, { useState } from 'react'
import { api } from '../lib/api'
import { useAuth } from '../lib/auth'
import { useFetch } from '../hooks/useFetch'
import { Trash2, UserPlus, Users as UsersIcon } from 'lucide-react'
import { PageHeader, Card, Spinner, ErrorAlert, EmptyState, Button, Icon, CHIP_CLASS } from '../components/UI'
import UserDialog from '../components/users/UserDialog'
import Modal, { ModalFooter, CancelButton } from '../components/Modal'
import { FormMessage } from '../components/FormField'

const formatDate = (ms) => (ms ? new Date(ms).toLocaleString() : 'Never')

const RoleBadge = ({ role }) => <span className={CHIP_CLASS}>{role}</span>

function DeleteDialog({ user, onConfirm, onClose }) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState(null)

  async function handleConfirm() {
    setDeleting(true)
    setError(null)
    try {
      await onConfirm()
    } catch (err) {
      setError(err.message)
      setDeleting(false)
    }
  }

  return (
    <Modal icon={Trash2} title="Delete user" subtitle={user.username} subtitleClassName="font-mono" onClose={onClose}>
      <div className="px-6 py-5 space-y-3 text-sm text-zinc-400">
        <p>
          Delete <span className="font-mono text-zinc-200">{user.username}</span>? Their sessions end immediately.
          This cannot be undone. Disable the account instead if you may need it again.
        </p>
        <FormMessage message={error && { type: 'error', text: error }} />
      </div>
      <ModalFooter>
        <CancelButton onClick={onClose} />
        <Button variant="danger" disabled={deleting} onClick={handleConfirm}>{deleting ? 'Deleting…' : 'Delete user'}</Button>
      </ModalFooter>
    </Modal>
  )
}

function UserRow({ user, isSelf, onEdit, onDelete }) {
  return (
    <tr className={`hover:bg-zinc-800/30 transition-colors ${user.disabled ? 'opacity-50' : ''}`}>
      <td className="px-5 py-3.5">
        <p className="font-mono text-xs text-zinc-200">
          {user.username}
          {isSelf && <span className="ml-2 text-[10px] text-emerald-400 font-sans uppercase tracking-wider">you</span>}
        </p>
        {(user.displayName || user.email) && (
          <p className="text-xs text-zinc-400 mt-0.5">{[user.displayName, user.email].filter(Boolean).join(' · ')}</p>
        )}
      </td>
      <td className="px-5 py-3.5"><RoleBadge role={user.role} /></td>
      <td className="px-5 py-3.5 text-xs">
        {user.disabled ? <span className="text-red-400">Disabled</span> : <span className="text-zinc-400">Active</span>}
      </td>
      <td className="px-5 py-3.5 text-zinc-400 text-xs">{formatDate(user.lastLoginAt)}</td>
      <td className="px-5 py-3.5">
        <div className="flex justify-end gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => onEdit(user)}>Edit</Button>
          {!isSelf && <Button size="sm" variant="danger" aria-label={`Delete user ${user.username}`} onClick={() => onDelete(user)}><Icon as={Trash2} /></Button>}
        </div>
      </td>
    </tr>
  )
}

function UsersTable({ users, selfId, onEdit, onDelete }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-zinc-400 uppercase tracking-wider border-b border-zinc-800 bg-zinc-950/50">
              <th className="px-5 py-3 font-medium">User</th>
              <th className="px-5 py-3 font-medium">Role</th>
              <th className="px-5 py-3 font-medium">Status</th>
              <th className="px-5 py-3 font-medium">Last sign-in</th>
              <th className="px-5 py-3 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {users.map((u) => (
              <UserRow key={u.id} user={u} isSelf={u.id === selfId} onEdit={onEdit} onDelete={onDelete} />
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

/** Admin page: list, create, edit and delete user accounts. */
export default function Users() {
  const { user: me, refresh: refreshMe } = useAuth()
  const { data: users, loading, error, reload } = useFetch(api.users.list)
  // dialog: null | { type: 'create' } | { type: 'edit', user } | { type: 'delete', user }
  const [dialog, setDialog] = useState(null)
  const close = () => setDialog(null)

  async function handleSave(payload) {
    const isSelf = dialog.user?.id === me?.id
    if (dialog.type === 'create') await api.users.create(payload)
    else await api.users.update(dialog.user.id, payload)
    close()
    reload()
    if (isSelf) refreshMe() // own role or name may have changed
  }

  async function handleDelete() {
    await api.users.delete(dialog.user.id)
    close()
    reload()
  }

  return (
    <div className="p-4 md:p-8">
      <PageHeader
        title="Users"
        subtitle="Accounts that can sign in to this UI. Only admins can manage users."
        action={<Button onClick={() => setDialog({ type: 'create' })}><Icon as={UserPlus} /> New user</Button>}
      />

      {loading && <div className="flex justify-center py-20"><Spinner /></div>}
      {error && <ErrorAlert message={error} onRetry={reload} />}
      {!loading && !error && users?.length === 0 && (
        <EmptyState icon={UsersIcon} title="No users" description="Create the first account with “New user”." />
      )}
      {!loading && !error && users?.length > 0 && (
        <UsersTable
          users={users}
          selfId={me?.id}
          onEdit={(user) => setDialog({ type: 'edit', user })}
          onDelete={(user) => setDialog({ type: 'delete', user })}
        />
      )}

      {(dialog?.type === 'create' || dialog?.type === 'edit') && (
        <UserDialog user={dialog.user ?? null} isSelf={dialog.user?.id === me?.id} onSubmit={handleSave} onClose={close} />
      )}
      {dialog?.type === 'delete' && <DeleteDialog user={dialog.user} onConfirm={handleDelete} onClose={close} />}
    </div>
  )
}
