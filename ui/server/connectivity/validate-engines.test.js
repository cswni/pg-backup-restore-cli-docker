const { test } = require('node:test')
const assert = require('node:assert/strict')
const { validateServerInput } = require('./validate')

const ENGINES = ['postgres', 'mysql', 'mongodb']
const base = { kind: 'direct', name: 'db', host: 'db.example.com', username: 'u', password: 'p' }

test('direct servers get per-engine default ports and maintenance databases', () => {
  const expected = { postgres: [5432, 'postgres'], mysql: [3306, 'mysql'], mongodb: [27017, 'admin'] }
  for (const engine of ENGINES) {
    const record = validateServerInput({ ...base, engine }, null, ENGINES)
    assert.deepEqual([record.port, record.database], expected[engine], engine)
    assert.equal(record.engine, engine)
  }
})

test('explicit ports and databases are kept; unknown engines are rejected', () => {
  const record = validateServerInput({ ...base, engine: 'mongodb', port: 27018, database: 'appauth' }, null, ENGINES)
  assert.deepEqual([record.port, record.database], [27018, 'appauth'])
  assert.throws(() => validateServerInput({ ...base, engine: 'oracle' }, null, ENGINES), /Unsupported engine/)
})
