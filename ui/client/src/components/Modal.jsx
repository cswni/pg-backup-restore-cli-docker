import React, { useId, useRef } from 'react'
import { useDialogFocus } from '../hooks/useDialogFocus'

const WIDTHS = { md: 'max-w-md', lg: 'max-w-lg', xl: 'max-w-xl' }

/** Header close button, at least 44px square for touch. */
export function CloseButton({ onClick, label = 'Close' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      data-dialog-close
      className="shrink-0 min-w-[44px] min-h-[44px] -mr-2 flex items-center justify-center rounded-lg text-xl leading-none text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
    >
      <span aria-hidden="true">✕</span>
    </button>
  )
}

/**
 * Accessible modal dialog: role="dialog" + aria-modal, labelled by its title,
 * Escape closes, focus moves in, stays in and returns to the opener on close.
 * The overlay scrolls, so tall dialogs stay usable on short screens.
 * @param {{ title: string, subtitle?: React.ReactNode, subtitleClassName?: string, icon?: React.ReactNode,
 *   onClose: () => void, size?: 'md'|'lg'|'xl', children: React.ReactNode }} props
 */
export default function Modal({ title, subtitle, subtitleClassName = '', icon, onClose, size = 'md', children }) {
  const ref = useRef(null)
  const titleId = useId()
  const subtitleId = useId()
  useDialogFocus(ref, onClose)

  return (
    <div className="fixed inset-0 z-50 flex overflow-y-auto bg-black/70 backdrop-blur-xs p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={subtitle ? subtitleId : undefined}
        tabIndex={-1}
        className={`m-auto bg-zinc-900 border border-zinc-700 rounded-2xl w-full ${WIDTHS[size]} shadow-2xl outline-hidden`}
      >
        <div className="flex items-center gap-3 px-6 py-4 border-b border-zinc-800">
          {icon && <span aria-hidden="true" className="text-2xl">{icon}</span>}
          <div className="flex-1 min-w-0">
            <h2 id={titleId} className="font-semibold text-zinc-100">{title}</h2>
            {subtitle && <p id={subtitleId} className={`text-xs text-zinc-400 mt-0.5 ${subtitleClassName}`}>{subtitle}</p>}
          </div>
          <CloseButton onClick={onClose} />
        </div>
        {children}
      </div>
    </div>
  )
}

/** Footer row of a Modal. */
export function ModalFooter({ children }) {
  return <div className="flex flex-wrap justify-end gap-2 px-6 py-4 border-t border-zinc-800">{children}</div>
}

/** Plain button that never submits the surrounding form. */
export function CancelButton({ onClick, children = 'Cancel' }) {
  return (
    <button type="button" onClick={onClick} className="px-4 py-2 text-sm font-medium rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-all">
      {children}
    </button>
  )
}
