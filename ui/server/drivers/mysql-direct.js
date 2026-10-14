const fs = require('fs')
const os = require('os')
const path = require('path')
const childProcess = require('child_process')
const { withConnection } = require('../connectivity/tunnel')
const { capture, toolEnv } = require('../connectivity/process')
const { createMysqlDriver } = require('./mysql-common')

// MySQL / MariaDB reached directly over TCP (optionally through an SSH
// tunnel). The MariaDB client tools of this image (`mariadb`,
// `mariadb-dump`) run locally. User and password go into a private option
// file (mode 0600 in a fresh temp directory, deleted afterwards) passed with
// --defaults-extra-file; nothing secret is on the command line.

const QUERY_TIMEOUT_MS = 60000
const CONNECT_TIMEOUT_S = '10'
const TOOLS = { dump: 'mariadb-dump', client: 'mariadb' }

/** Value for a MySQL option file: double-quoted with \ " and newlines escaped. */
function optionValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`
}

/** Write the [client] option file; returns { file, cleanup }. */
function writeOptionFile(conn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pgui-mysql-'))
  const file = path.join(dir, 'client.cnf')
  const lines = ['[client]', `user=${optionValue(conn.username)}`]
  if (conn.password) lines.push(`password=${optionValue(conn.password)}`)
  fs.writeFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 })
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
}

/**
 * TLS options for the MariaDB client from the server's sslmode.
 * verify-full cannot check the host name through a tunnel (the client would
 * see 127.0.0.1), so that combination is rejected.
 */
function sslArgs(conn) {
  switch (conn.sslmode) {
    case 'disable': return ['--skip-ssl']
    case 'require': return ['--ssl', '--skip-ssl-verify-server-cert']
    case 'verify-full':
      if (conn.tlsServerName) throw new Error("sslmode 'verify-full' is not supported through an SSH tunnel for MySQL. Use 'require'.")
      return ['--ssl', '--ssl-verify-server-cert']
    default: return ['--skip-ssl-verify-server-cert'] // prefer: TLS when offered, unverified
  }
}

/** Connection arguments; the option file must come first. */
function connArgs(conn, optionFile, tool) {
  return [
    `--defaults-extra-file=${optionFile}`,
    `--host=${conn.host}`, `--port=${conn.port}`, '--protocol=TCP',
    ...sslArgs(conn),
    // The client refuses \! and other shell meta-commands from (untrusted) dumps
    ...(tool === 'client' ? [`--connect-timeout=${CONNECT_TIMEOUT_S}`, '--sandbox'] : []),
  ]
}

function open(target, fn, opts) {
  return withConnection(target.server, async (conn) => {
    const { file, cleanup } = writeOptionFile(conn)
    const full = (tool, args) => [...connArgs(conn, file, tool), ...args]
    try {
      return await fn({
        spawn: (tool, args) => childProcess.spawn(TOOLS[tool], full(tool, args), { env: toolEnv() }),
        capture: (tool, args) => capture(TOOLS[tool], full(tool, args), { env: toolEnv(), timeout: QUERY_TIMEOUT_MS }),
      })
    } finally {
      cleanup()
    }
  }, opts)
}

module.exports = {
  ...createMysqlDriver({ kind: 'direct', open }),
  _internals: { optionValue, sslArgs, connArgs },
}
