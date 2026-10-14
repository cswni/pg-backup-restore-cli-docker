import React from 'react'
import { KeyRound } from 'lucide-react'
import { api } from '../../lib/api'
import { useRequest } from '../../hooks/useRequest'
import { ErrorAlert, CHIP_CLASS } from '../UI'
import Loading from './Loading'

const TH = 'px-3 py-3 font-medium whitespace-nowrap'
const TD = 'px-3 py-3 align-top'

function SimpleTable({ caption, headers, children }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-800" tabIndex={0} role="region" aria-label={caption}>
      <table className="min-w-full text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead className="bg-zinc-950 text-left text-xs text-zinc-400">
          <tr className="border-b border-zinc-800">
            {headers.map((h) => <th key={h} scope="col" className={TH}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800/60">{children}</tbody>
      </table>
    </div>
  )
}

function ColumnsTable({ label, columns }) {
  if (!columns.length) return <p className="text-sm text-zinc-400">No columns reported.</p>
  return (
    <SimpleTable caption={`Columns of ${label}`} headers={['Name', 'Type', 'Nullable', 'Default', 'Primary key']}>
      {columns.map((c) => (
        <tr key={c.name}>
          <th scope="row" className={`${TD} text-left font-mono text-xs font-normal text-zinc-100 break-all`}>{c.name}</th>
          <td className={`${TD} font-mono text-xs text-zinc-300 break-all`}>{c.type}</td>
          <td className={`${TD} text-xs text-zinc-300`}>{c.nullable ? 'yes' : 'no'}</td>
          <td className={`${TD} font-mono text-xs break-all ${c.default == null ? 'text-zinc-400' : 'text-zinc-300'}`}>
            {c.default ?? <span className="font-sans italic">no default</span>}
          </td>
          <td className={`${TD} text-xs`}>
            {c.primaryKey && (
              <span className={CHIP_CLASS}><KeyRound aria-hidden="true" className="size-3" /> primary key</span>
            )}
          </td>
        </tr>
      ))}
    </SimpleTable>
  )
}

function IndexesTable({ label, indexes }) {
  if (!indexes.length) return <p className="text-sm text-zinc-400">No indexes on {label}.</p>
  return (
    <SimpleTable caption={`Indexes of ${label}`} headers={['Name', 'Columns', 'Unique']}>
      {indexes.map((ix) => (
        <tr key={ix.name}>
          <th scope="row" className={`${TD} text-left font-mono text-xs font-normal text-zinc-100 break-all`}>{ix.name}</th>
          <td className={`${TD} font-mono text-xs text-zinc-300 break-all`}>{ix.columns.join(', ')}</td>
          <td className={`${TD} text-xs text-zinc-300`}>{ix.unique ? 'yes' : 'no'}</td>
        </tr>
      ))}
    </SimpleTable>
  )
}

/**
 * Columns and indexes of one object. For MongoDB the server samples up to
 * 100 documents, so the field list is what those documents contain.
 * @param {{ base: object, object: { schema: string|null, name: string }, engine: string }} props
 */
export default function StructureTab({ base, object, engine }) {
  const params = { ...base, schema: object.schema ?? undefined, name: object.name }
  const structure = useRequest(() => api.explorer.structure(params), [JSON.stringify(params)])
  const label = `${object.schema ? `${object.schema}.` : ''}${object.name}`
  const isMongo = engine === 'mongodb'

  if (structure.loading && !structure.data) return <Loading>Loading the structure…</Loading>
  if (structure.error) return <ErrorAlert message={structure.error} onRetry={structure.reload} />
  if (!structure.data) return null

  return (
    <div className="space-y-6">
      <section>
        <h3 className="text-sm font-semibold text-zinc-200 mb-1">{isMongo ? 'Fields' : 'Columns'}</h3>
        {isMongo && (
          <p className="text-xs text-zinc-400 mb-3">
            Read from a sample of up to 100 documents. Types list every BSON type seen for the field.
          </p>
        )}
        <div className={isMongo ? '' : 'mt-3'}>
          <ColumnsTable label={label} columns={structure.data.columns} />
        </div>
      </section>
      <section>
        <h3 className="text-sm font-semibold text-zinc-200 mb-3">Indexes</h3>
        <IndexesTable label={label} indexes={structure.data.indexes} />
      </section>
    </div>
  )
}
