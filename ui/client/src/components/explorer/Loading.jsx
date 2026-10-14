import React from 'react'
import { LoaderCircle } from 'lucide-react'

/** Visible "what is loading" line; announced politely to screen readers. */
export default function Loading({ children, className = 'py-10 justify-center' }) {
  return (
    <p role="status" className={`flex items-center gap-2 text-sm text-zinc-400 ${className}`}>
      <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-emerald-400" />
      {children}
    </p>
  )
}
