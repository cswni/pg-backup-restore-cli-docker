import React, { useId } from 'react'
import { Copy, KeyRound } from 'lucide-react'
import { CHIP_CLASS } from '../UI'
import { FOCUS_RING, NullToken } from './DataGrid'
import { fullCellText, cellNote } from './cells'
import { usesTextarea } from './rowValues'

const INPUT_CLASS = `w-full min-h-[44px] bg-zinc-800 border rounded-lg px-3 py-2 text-base sm:text-sm font-mono text-zinc-100 placeholder-zinc-400 disabled:opacity-60 disabled:cursor-not-allowed ${FOCUS_RING} focus-visible:outline-offset-0 transition-colors`
const SCROLL_HINT_LENGTH = 300

function FieldHeading({ field, htmlFor }) {
  const Name = htmlFor ? 'label' : 'p'
  return (
    <div className="min-w-0">
      <Name htmlFor={htmlFor} className="block font-mono text-sm text-zinc-100 break-all">{field.name}</Name>
      <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-zinc-400">
        {field.column && <span className="font-mono break-all">{field.column.type}</span>}
        {field.column?.nullable && <span>nullable</span>}
        {field.isKey && <span className={CHIP_CLASS}><KeyRound aria-hidden="true" className="size-3" /> primary key</span>}
      </p>
    </div>
  )
}

function CellValue({ field }) {
  const { cell, name } = field
  if (cell === null) return <p className="mt-2 font-mono text-xs text-zinc-400"><NullToken /></p>
  const text = fullCellText(cell)
  const note = cellNote(cell)
  const scrolls = text.length > SCROLL_HINT_LENGTH
  return (
    <>
      {note && <p className="mt-2 text-xs text-zinc-400">{note}</p>}
      <pre
        tabIndex={scrolls ? 0 : undefined}
        aria-label={scrolls ? `Value of ${name}` : undefined}
        className={`mt-2 max-h-64 overflow-auto rounded-lg bg-zinc-950 border border-zinc-800 px-3 py-2 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-all ${scrolls ? FOCUS_RING : ''}`}
      >
        {text}
      </pre>
    </>
  )
}

function CopyButton({ field, onCopy }) {
  return (
    <button
      type="button"
      onClick={() => onCopy(field)}
      aria-label={`Copy the value of ${field.name}`}
      className={`shrink-0 -mr-2 min-w-[44px] min-h-[44px] flex items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors ${FOCUS_RING}`}
    >
      <Copy aria-hidden="true" className="size-4" />
    </button>
  )
}

/** Inputs for one editable field: text, number, true/false or JSON, plus a NULL box for nullable columns. */
function FieldInput({ field, draft, onDraft, error, inputId, engine }) {
  const nullId = useId()
  const errorId = useId()
  const hintId = useId()
  const hint = engine === 'mongodb' && field.kind === 'json'
    ? 'Saved as JSON. Dates and ObjectIds inside this value are saved as text.'
    : null
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined
  const common = {
    id: inputId,
    disabled: draft.isNull,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': describedBy,
    className: `${INPUT_CLASS} ${error ? 'border-red-500/70' : 'border-zinc-500 focus:border-emerald-500'}`,
  }
  const setText = (text) => onDraft({ ...draft, text })

  let control
  if (field.kind === 'boolean') {
    control = (
      <select {...common} value={draft.text || 'false'} onChange={(e) => setText(e.target.value)}>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    )
  } else if (usesTextarea(field, draft.text)) {
    const lines = Math.min(10, Math.max(3, draft.text.split('\n').length))
    control = <textarea {...common} rows={lines} spellCheck={false} value={draft.text} onChange={(e) => setText(e.target.value)} />
  } else {
    const numeric = ['integer', 'float', 'exact'].includes(field.kind)
    control = (
      <input {...common} type="text" inputMode={numeric ? 'decimal' : undefined} spellCheck={false}
        value={draft.text} onChange={(e) => setText(e.target.value)} />
    )
  }

  return (
    <div className="mt-2">
      {control}
      {field.nullable && (
        <label htmlFor={nullId} className="mt-1 inline-flex min-h-[44px] items-center gap-2 text-sm text-zinc-300 cursor-pointer">
          <input id={nullId} type="checkbox" checked={draft.isNull} onChange={(e) => onDraft({ ...draft, isNull: e.target.checked })}
            className="size-4 accent-emerald-500" />
          NULL
        </label>
      )}
      {hint && <p id={hintId} className="mt-1 text-xs text-zinc-400">{hint}</p>}
      {error && <p id={errorId} role="alert" className="mt-1 text-xs text-red-400 break-words">{error}</p>}
    </div>
  )
}

/**
 * One field of the row dialog. In edit mode an unlocked field gets an input;
 * a locked one keeps showing its value with the reason it can't be edited.
 * @param {{ field: object, isEditing: boolean, draft?: { text: string, isNull: boolean },
 *   onDraft?: (draft: object) => void, error?: string, onCopy: (field: object) => void, engine: string }} props
 */
export default function RowField({ field, isEditing, draft, onDraft, error, onCopy, engine }) {
  const inputId = useId()
  const hasInput = isEditing && !field.lock && draft
  return (
    <li className="py-3">
      <div className="flex items-start justify-between gap-2">
        <FieldHeading field={field} htmlFor={hasInput ? inputId : undefined} />
        {!isEditing && <CopyButton field={field} onCopy={onCopy} />}
      </div>
      {hasInput
        ? <FieldInput field={field} draft={draft} onDraft={onDraft} error={error} inputId={inputId} engine={engine} />
        : <CellValue field={field} />}
      {isEditing && field.lock && <p className="mt-1.5 text-xs text-zinc-400">{field.lock}</p>}
    </li>
  )
}
