import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pencil, RotateCw, Trash2 } from 'lucide-react'
import Modal, { ModalFooter } from '../Modal'
import { Button, BusyIcon, ErrorAlert, Icon } from '../UI'
import { api, ApiError } from '../../lib/api'
import { copyText } from '../../lib/clipboard'
import { FOCUS_RING } from './DataGrid'
import { fullCellText } from './cells'
import Loading from './Loading'
import RowField from './RowField'
import { buildFields, keyOf, initialDraft, isDraftChanged, buildUpdate, buildDeleteOriginal, describeKey } from './rowValues'

const CONFLICT_MESSAGE = 'This row changed or no longer exists. Reload and try again.'
const BTN = `min-h-[44px] ${FOCUS_RING}`

/** Why an admin can't change this row, or null when they can. */
function writeBlocker(structure, key) {
  if (!structure) return null
  if (structure.editable !== true) return structure.editableReason || 'This object can\'t be changed here.'
  if (!key) return 'The primary key of this row could not be read in full, so it can\'t be changed here.'
  return null
}

function ActionError({ error, onReload }) {
  if (!error) return null
  if (!error.isConflict) return <div className="mt-3"><ErrorAlert message={error.message} /></div>
  return (
    <div role="alert" className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-red-500/20 bg-red-500/10 p-4 text-sm text-red-400">
      <p className="flex-1 min-w-[12rem]">{CONFLICT_MESSAGE}</p>
      <Button variant="secondary" onClick={onReload} className={BTN}><Icon as={RotateCw} /> Reload</Button>
    </div>
  )
}

function DeleteConfirm({ noun, objectLabel, objectNoun, keyText }) {
  return (
    <div>
      <p className="text-sm font-medium text-zinc-100">Delete this {noun}? This can't be undone.</p>
      <dl className="mt-4 space-y-3 text-sm">
        <div>
          <dt className="text-xs text-zinc-400">{objectNoun}</dt>
          <dd className="mt-0.5 font-mono text-zinc-200 break-all">{objectLabel}</dd>
        </div>
        <div>
          <dt className="text-xs text-zinc-400">Primary key</dt>
          <dd className="mt-0.5 font-mono text-zinc-200 break-all">{keyText}</dd>
        </div>
      </dl>
      <p className="mt-4 text-xs text-zinc-400">The delete only goes through if the {noun} still holds the values you loaded.</p>
    </div>
  )
}

const EDIT_FOCUS = 'input:not([disabled]), textarea:not([disabled]), select:not([disabled])'

/**
 * Moves focus when the mode changes (not on first open): the first input in
 * edit mode, otherwise the element marked data-autofocus.
 */
function useModeFocus(containerRef, mode) {
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    const node = containerRef.current
    const target = (mode === 'edit' && node?.querySelector(EDIT_FOCUS)) || node?.querySelector('[data-autofocus]')
    target?.focus()
  }, [containerRef, mode])
}

/**
 * One row (or MongoDB document) of the Data tab. Everyone sees every field;
 * admins can edit or delete it when the structure says the object is editable.
 * @param {{ target: object, object: object, engine: string, columns: string[], row: unknown[], rowNumber: number,
 *   structure: { data: object|null, error: string|null, loading: boolean, reload: () => void },
 *   isAdmin: boolean, onClose: () => void, onDone: (message: string) => void, onReloadRows: () => void }} props
 */
export default function RowDialog({ target, object, engine, columns, row, rowNumber, structure, isAdmin, onClose, onDone, onReloadRows }) {
  const containerRef = useRef(null)
  const [mode, setMode] = useState('view')
  const [drafts, setDrafts] = useState({})
  const [fieldErrors, setFieldErrors] = useState({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [copyStatus, setCopyStatus] = useState('')
  const [invalidTick, setInvalidTick] = useState(0)
  useModeFocus(containerRef, mode)
  useEffect(() => {
    if (invalidTick) containerRef.current?.querySelector('[aria-invalid="true"]')?.focus()
  }, [invalidTick])

  const fields = useMemo(() => buildFields({ engine, columns, row, structure: structure.data }), [engine, columns, row, structure.data])
  const key = useMemo(() => keyOf(fields, structure.data), [fields, structure.data])
  const blocker = isAdmin ? writeBlocker(structure.data, key) : null
  const canWrite = isAdmin && Boolean(structure.data) && !blocker

  const isMongo = engine === 'mongodb'
  const noun = isMongo ? 'document' : 'row'
  const objectLabel = `${object.schema ? `${object.schema}.` : ''}${object.name}`
  const objectNoun = object.type === 'collection' ? 'Collection' : 'Table'
  const title = `${isMongo ? 'Document' : 'Row'} ${rowNumber}`
  const subtitle = key ? `${objectLabel}, ${describeKey(key)}` : objectLabel
  const hasChanges = fields.some((f) => !f.lock && drafts[f.name] && isDraftChanged(f, drafts[f.name]))

  function changeMode(next) {
    setError(null)
    setFieldErrors({})
    setMode(next)
  }

  function startEdit() {
    setDrafts(Object.fromEntries(fields.filter((f) => !f.lock).map((f) => [f.name, initialDraft(f)])))
    changeMode('edit')
  }

  function handleDraft(name, draft) {
    setDrafts((d) => ({ ...d, [name]: draft }))
    if (fieldErrors[name]) setFieldErrors(({ [name]: _cleared, ...rest }) => rest)
  }

  async function handleCopy(field) {
    const copied = await copyText(fullCellText(field.cell))
    setCopyStatus(copied ? `Copied the value of ${field.name}.` : 'Copy failed. Select the text and copy it by hand.')
  }

  async function run(request, message) {
    setBusy(true)
    setError(null)
    try {
      await request()
      onDone(message)
    } catch (e) {
      const isConflict = e instanceof ApiError && e.status === 409
      setError({ isConflict, message: e.message || 'Request failed' })
      setBusy(false)
    }
  }

  function handleSave(e) {
    e.preventDefault()
    if (mode !== 'edit' || busy) return
    const { changes, original, errors } = buildUpdate(fields, drafts)
    setFieldErrors(errors)
    if (Object.keys(errors).length) {
      setInvalidTick((n) => n + 1)
      return
    }
    const names = Object.keys(changes)
    if (!names.length) return
    run(() => api.explorer.updateRow({ ...target, key, original, changes }),
      `Saved ${names.length === 1 ? names[0] : `${names.length} fields`} in ${objectLabel}.`)
  }

  function handleDelete() {
    run(() => api.explorer.deleteRow({ ...target, key, original: buildDeleteOriginal(fields) }),
      `Deleted the ${noun} with ${describeKey(key)} from ${objectLabel}.`)
  }

  const isEditing = mode === 'edit'
  const body = mode === 'delete'
    ? <DeleteConfirm noun={noun} objectLabel={objectLabel} objectNoun={objectNoun} keyText={describeKey(key)} />
    : (
      <>
        {structure.loading && !structure.data && <Loading>Loading column types…</Loading>}
        {structure.error && <ErrorAlert message={`Column types could not be loaded. ${structure.error}`} onRetry={structure.reload} />}
        {blocker && <p className="mb-2 text-sm text-zinc-300">{blocker}</p>}
        {isEditing && (
          <p className="mb-2 text-sm text-zinc-300">
            Only the fields you change are saved, and only if nobody changed them since you loaded this page.
          </p>
        )}
        <ul className="divide-y divide-zinc-800">
          {fields.map((field) => (
            <RowField key={field.name} field={field} engine={engine} isEditing={isEditing} onCopy={handleCopy}
              draft={drafts[field.name]} error={fieldErrors[field.name]}
              onDraft={(draft) => handleDraft(field.name, draft)} />
          ))}
        </ul>
      </>
    )

  return (
    <Modal title={title} subtitle={subtitle} subtitleClassName="font-mono break-all" size="2xl" onClose={onClose}>
      <form ref={containerRef} onSubmit={handleSave} noValidate>
        <div className="max-h-[60dvh] overflow-y-auto px-6 py-4">
          {body}
          <ActionError error={error} onReload={onReloadRows} />
          {mode === 'view' && <p role="status" className="mt-2 min-h-[1.25rem] text-xs text-zinc-400">{copyStatus}</p>}
        </div>
        <ModalFooter>
          {mode === 'view' && (
            <>
              {canWrite && (
                <Button type="button" variant="secondary" onClick={() => changeMode('delete')} className={`${BTN} sm:mr-auto`}>
                  <Icon as={Trash2} /> Delete
                </Button>
              )}
              {canWrite && <Button type="button" variant="secondary" onClick={startEdit} className={BTN} data-autofocus><Icon as={Pencil} /> Edit</Button>}
              <Button type="button" onClick={onClose} className={BTN} data-autofocus={canWrite ? undefined : true}>Close</Button>
            </>
          )}
          {isEditing && (
            <>
              <Button type="button" variant="ghost" onClick={() => changeMode('view')} disabled={busy} className={BTN}>Cancel</Button>
              <Button type="submit" disabled={busy || !hasChanges} className={BTN}>
                {busy && <BusyIcon />} Save changes
              </Button>
            </>
          )}
          {mode === 'delete' && (
            <>
              <Button type="button" variant="secondary" onClick={() => changeMode('view')} disabled={busy} className={BTN} data-autofocus>Cancel</Button>
              <Button type="button" variant="danger" onClick={handleDelete} disabled={busy} className={BTN}>
                {busy ? <BusyIcon /> : <Icon as={Trash2} />} Delete {noun}
              </Button>
            </>
          )}
        </ModalFooter>
      </form>
    </Modal>
  )
}
