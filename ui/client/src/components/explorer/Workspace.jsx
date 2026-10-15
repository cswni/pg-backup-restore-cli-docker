import React, { useId, useRef, useState } from 'react'
import { CHIP_CLASS } from '../UI'
import DataTab from './DataTab'
import StructureTab from './StructureTab'
import QueryTab from './QueryTab'
import { objectKey } from './ObjectList'

const TAB_LABELS = { data: 'Data', structure: 'Structure', query: 'Query' }
const SQL_ENGINES = ['postgres', 'mysql']

/** The Query tab exists for admins on PostgreSQL and MySQL only (the API enforces it too). */
export function availableTabs(engine, isAdmin) {
  return isAdmin && SQL_ENGINES.includes(engine) ? ['data', 'structure', 'query'] : ['data', 'structure']
}

/** Tab strip with arrow-key navigation (WAI-ARIA tabs pattern, automatic activation). */
function TabList({ tabs, active, onChange, idFor }) {
  const refs = useRef({})
  function handleKeyDown(e) {
    const i = tabs.indexOf(active)
    const moves = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: tabs.length - 1 }
    if (!(e.key in moves)) return
    e.preventDefault()
    const next = tabs[(moves[e.key] + tabs.length) % tabs.length]
    onChange(next)
    refs.current[next]?.focus()
  }
  return (
    <div role="tablist" aria-label="Views" className="flex gap-1 border-b border-zinc-800 mb-4 overflow-x-auto overflow-y-hidden" onKeyDown={handleKeyDown}>
      {tabs.map((tab) => {
        const isActive = tab === active
        return (
          <button
            key={tab}
            ref={(el) => { refs.current[tab] = el }}
            type="button"
            role="tab"
            id={idFor(tab, 'tab')}
            aria-selected={isActive}
            aria-controls={idFor(tab, 'panel')}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(tab)}
            className={`shrink-0 min-h-[44px] px-3 sm:px-4 border-b-2 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-emerald-400 ${
              isActive ? 'border-emerald-400 text-zinc-100' : 'border-transparent text-zinc-400 hover:text-zinc-100'
            }`}
          >
            {TAB_LABELS[tab]}
          </button>
        )
      })}
    </div>
  )
}

function ObjectHeading({ object }) {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-4 min-w-0">
      <h2 className="font-semibold text-zinc-100 font-mono text-sm break-all">
        {object.schema ? <span className="text-zinc-400">{object.schema}.</span> : null}{object.name}
      </h2>
      <span className={CHIP_CLASS}>{object.type}</span>
    </div>
  )
}

/** Shown in Data and Structure while no object is open; `listState` comes from the object list request. */
function PickHint({ engine, missingObject, listState }) {
  const noun = engine === 'mongodb' ? 'collection' : 'table'
  let text = `Choose a ${noun} from the list to see its rows and structure.`
  if (listState === 'loading') text = `Waiting for the ${noun} list.`
  if (listState === 'error') text = `The ${noun} list could not be loaded. Retry it from the error message.`
  if (listState === 'empty') text = `There is no ${noun} to open in this database.`
  return (
    <p className="py-6 text-sm text-zinc-400">
      {missingObject && listState === 'ready' && <>This database has no {noun} named "{missingObject}". </>}
      {text}
    </p>
  )
}

/**
 * Data, Structure and Query tabs for the chosen database. Panels mount on
 * first visit and stay mounted, so switching tabs keeps the page and sort.
 * @param {{ base: object, engine: string, object: object|null, tab: string, onTab: (tab: string) => void,
 *   isAdmin: boolean, missingObject: string|null, listState: 'loading'|'error'|'empty'|'ready' }} props
 */
export default function Workspace({ base, engine, object, tab, onTab, isAdmin, missingObject, listState }) {
  const prefix = useId()
  const tabs = availableTabs(engine, isAdmin)
  const active = tabs.includes(tab) ? tab : 'data'
  const [visited, setVisited] = useState(() => new Set([active]))
  const [sql, setSql] = useState('')
  if (!visited.has(active)) setVisited(new Set([...visited, active]))

  const idFor = (t, part) => `${prefix}-${t}-${part}`
  const key = object ? objectKey(object) : 'none'
  const panels = {
    data: object ? <DataTab key={key} base={base} object={object} engine={engine} isAdmin={isAdmin} /> : <PickHint engine={engine} missingObject={missingObject} listState={listState} />,
    structure: object ? <StructureTab key={key} base={base} object={object} engine={engine} /> : <PickHint engine={engine} missingObject={missingObject} listState={listState} />,
    query: <QueryTab base={base} sql={sql} onSqlChange={setSql} />,
  }

  return (
    <div className="min-w-0">
      {object && active !== 'query' && <ObjectHeading object={object} />}
      <TabList tabs={tabs} active={active} onChange={onTab} idFor={idFor} />
      {tabs.map((t) => (
        <div key={t} role="tabpanel" id={idFor(t, 'panel')} aria-labelledby={idFor(t, 'tab')} hidden={t !== active}>
          {visited.has(t) && panels[t]}
        </div>
      ))}
    </div>
  )
}
