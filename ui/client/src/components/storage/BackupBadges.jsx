import React from 'react'

const TYPE_LABEL = { s3: 'S3', gdrive: 'Google Drive' }

function Badge({ title, className, children }) {
  return (
    <span title={title} className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-medium border ${className}`}>
      {children}
    </span>
  )
}

/** gz / encrypted / remote-copy / remote-only badges for a backup list row. */
export default function BackupBadges({ backup }) {
  const locations = backup.locations || []
  const compressed = backup.compressed || /\.gz(\.enc)?$/i.test(backup.name)
  const encrypted = backup.encrypted || /\.enc$/i.test(backup.name)
  const where = locations.map((l) => TYPE_LABEL[l.type] || l.type).join(', ')
  return (
    <span className="inline-flex flex-wrap gap-1">
      {compressed && <Badge title="gzip compressed" className="bg-zinc-800 text-zinc-400 border-zinc-700">gz</Badge>}
      {encrypted && <Badge title="Encrypted (AES-256-GCM)" className="bg-amber-500/10 text-amber-300 border-amber-500/25">🔒 enc</Badge>}
      {locations.length > 0 && (
        <Badge title={`Remote copies: ${where}`} className="bg-sky-500/10 text-sky-300 border-sky-500/20">☁ {locations.length}</Badge>
      )}
      {backup.local === false && (
        <Badge title="The local file was removed; restore downloads it from a remote copy" className="bg-violet-500/10 text-violet-300 border-violet-500/20">
          remote only
        </Badge>
      )}
    </span>
  )
}
