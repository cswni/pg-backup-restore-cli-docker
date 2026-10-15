import React, { useState } from 'react'
import { ArrowDown, ArrowUp, ChevronsUpDown, Copy, Maximize2 } from 'lucide-react'
import Modal, { ModalFooter } from '../Modal'
import { Button, Icon } from '../UI'
import { copyText } from '../../lib/clipboard'
import { describeCell, fullCellText, cellNote } from './cells'

// Color stays for status; value kinds differ by tone and shape only.
const KIND_CLASS = {
  null: 'text-zinc-400',
  binary: 'italic text-zinc-400',
  truncated: 'text-zinc-200',
  json: 'text-zinc-200',
  text: 'text-zinc-200',
}

/** NULL as a small outlined token, so it never looks like the string "NULL". */
export function NullToken() {
  return <span className="rounded-md border border-zinc-600 px-1 py-px text-[11px] italic">NULL</span>
}

export const FOCUS_RING = 'focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-400'

function CellDetail({ column, cell, onClose }) {
  const [copyStatus, setCopyStatus] = useState('')
  const value = fullCellText(cell)

  async function handleCopy() {
    const copied = await copyText(value)
    setCopyStatus(copied ? 'Copied to the clipboard.' : 'Copy failed. Select the text and copy it by hand.')
  }

  return (
    <Modal title={column} subtitle={cellNote(cell)} size="xl" onClose={onClose}>
      <div className="px-6 py-4">
        <pre className="max-h-[60dvh] overflow-auto rounded-lg bg-zinc-950 border border-zinc-800 p-3 text-xs font-mono text-zinc-200 whitespace-pre-wrap break-all">
          {value}
        </pre>
        <p role="status" className="mt-2 min-h-[1.25rem] text-xs text-zinc-400">{copyStatus}</p>
      </div>
      <ModalFooter>
        <Button variant="secondary" onClick={handleCopy} className={`min-h-[44px] ${FOCUS_RING}`}>
          <Icon as={Copy} /> Copy value
        </Button>
        <Button onClick={onClose} className={`min-h-[44px] ${FOCUS_RING}`}>Close</Button>
      </ModalFooter>
    </Modal>
  )
}

function Cell({ cell, column, onOpen }) {
  const { kind, text, needsDetail } = describeCell(cell)
  const cls = KIND_CLASS[kind]
  if (!needsDetail) {
    return (
      <td className={`px-3 py-3 whitespace-nowrap font-mono text-xs ${cls}`}>
        {kind === 'null' ? <NullToken /> : text}
      </td>
    )
  }
  return (
    <td className="p-0">
      <button
        type="button"
        onClick={() => onOpen({ column, cell })}
        className={`w-full min-h-[44px] max-w-[28rem] px-3 inline-flex items-center gap-2 text-left font-mono text-xs hover:bg-zinc-800 ${FOCUS_RING} ${cls}`}
      >
        <span className="truncate">{text}</span>
        <Maximize2 aria-hidden="true" className="size-3.5 shrink-0 text-zinc-400" />
        <span className="sr-only">, show full value of {column}</span>
      </button>
    </td>
  )
}

function SortHeader({ column, sort, onSort }) {
  const active = sort?.column === column
  const dir = active ? sort.dir : null
  const Glyph = dir === 'asc' ? ArrowUp : dir === 'desc' ? ArrowDown : ChevronsUpDown
  const ariaSort = dir === 'asc' ? 'ascending' : dir === 'desc' ? 'descending' : 'none'
  return (
    <th scope="col" aria-sort={ariaSort} className="p-0 font-medium">
      <button
        type="button"
        onClick={() => onSort({ column, dir: active && dir === 'asc' ? 'desc' : 'asc' })}
        className={`w-full min-h-[44px] px-3 inline-flex items-center gap-1.5 whitespace-nowrap text-left hover:text-zinc-100 ${FOCUS_RING} ${active ? 'text-zinc-100' : ''}`}
      >
        {column}
        <Glyph aria-hidden="true" className={`size-3.5 shrink-0 ${active ? 'text-emerald-400' : 'text-zinc-400'}`} />
      </button>
    </th>
  )
}

const STICKY_CELL = 'sticky left-0 bg-zinc-900 p-0 border-r border-zinc-800'

function OpenRowCell({ label, onOpen }) {
  return (
    <td className={STICKY_CELL}>
      <button
        type="button"
        onClick={onOpen}
        aria-label={label}
        className={`min-w-[44px] min-h-[44px] px-3 inline-flex items-center justify-center text-xs font-medium text-zinc-300 hover:text-zinc-100 hover:bg-zinc-800 ${FOCUS_RING}`}
      >
        Open
      </button>
    </td>
  )
}

/** A click anywhere on a row opens it, except on its buttons or while text is being selected. */
function rowClickHandler(onOpen) {
  return (e) => {
    if (e.target.closest('button, a, input, textarea, select')) return
    if (window.getSelection()?.toString()) return
    onOpen()
  }
}

/**
 * Result grid shared by the Data and Query tabs: a real table with a caption,
 * sticky column headers, horizontal scroll inside its own box and a detail
 * dialog for long, binary and JSON values. With `onOpenRow`, each row gets an
 * "Open" button and a click on the row opens it too.
 * @param {{ caption: string, columns: string[], rows: unknown[][], rowOffset?: number,
 *   sort?: { column: string, dir: 'asc'|'desc' } | null, onSort?: (sort: object) => void,
 *   onOpenRow?: (index: number) => void, rowNoun?: string }} props
 */
export default function DataGrid({ caption, columns, rows, rowOffset = 0, sort = null, onSort, onOpenRow, rowNoun = 'row' }) {
  const [detail, setDetail] = useState(null)
  return (
    <>
      <div className="relative max-h-[65dvh] overflow-auto rounded-lg border border-zinc-800" tabIndex={0} aria-label={caption} role="region">
        <table className="min-w-full text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead className="sticky top-0 z-10 bg-zinc-950 text-left text-xs text-zinc-400">
            <tr className="border-b border-zinc-800">
              {onOpenRow && <th scope="col" className="sticky left-0 z-20 bg-zinc-950 px-3 py-3 font-medium border-r border-zinc-800"><span className="sr-only">Open</span></th>}
              {columns.map((column) => (onSort
                ? <SortHeader key={column} column={column} sort={sort} onSort={onSort} />
                : <th key={column} scope="col" className="px-3 py-3 font-medium whitespace-nowrap">{column}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60">
            {rows.map((row, i) => (
              <tr key={rowOffset + i} className={`hover:bg-zinc-800/30 ${onOpenRow ? 'cursor-pointer' : ''}`}
                onClick={onOpenRow ? rowClickHandler(() => onOpenRow(i)) : undefined}>
                {onOpenRow && <OpenRowCell label={`Open ${rowNoun} ${rowOffset + i + 1}`} onOpen={() => onOpenRow(i)} />}
                {columns.map((column, c) => (
                  <Cell key={column} column={column} cell={row[c]} onOpen={setDetail} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {detail && <CellDetail column={detail.column} cell={detail.cell} onClose={() => setDetail(null)} />}
    </>
  )
}
