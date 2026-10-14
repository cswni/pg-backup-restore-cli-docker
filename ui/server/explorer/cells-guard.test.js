const { setupTestEnv } = require('../test-helpers')
setupTestEnv()

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { textCell, binaryCell, jsonCell, slotCell } = require('./cells')
const { checkConsoleSql, isMysqlClientCommand } = require('./sql-guard')
const { intParam } = require('./params')

test('textCell keeps short strings and cuts long ones at 2000 characters', () => {
  assert.equal(textCell('abc'), 'abc')
  const long = 'x'.repeat(2500)
  assert.deepEqual(textCell(long), { truncated: true, value: 'x'.repeat(2000), length: 2500 })
  // Already cut by the database: the real length comes separately
  assert.deepEqual(textCell('y'.repeat(2000), 9000), { truncated: true, value: 'y'.repeat(2000), length: 9000 })
})

test('binaryCell reports length and a lowercase hex preview', () => {
  assert.deepEqual(binaryCell('70', 'DEADBEEF'), { binary: true, length: 70, preview: 'deadbeef' })
})

test('jsonCell truncates long strings and large nested values', () => {
  assert.equal(jsonCell(null), null)
  assert.equal(jsonCell(42), 42)
  assert.deepEqual(jsonCell({ a: 1 }), { a: 1 })
  const big = { text: 'z'.repeat(3000) }
  const cell = jsonCell(big)
  assert.equal(cell.truncated, true)
  assert.equal(cell.length, JSON.stringify(big).length)
  assert.equal(cell.value.length, 2000)
})

test('slotCell shapes [length, value] slots per column kind', () => {
  assert.equal(slotCell('text', null, null), null)
  assert.equal(slotCell('text', 3, 'abc'), 'abc')
  assert.deepEqual(slotCell('text', 5000, 'a'.repeat(2000)), { truncated: true, value: 'a'.repeat(2000), length: 5000 })
  assert.deepEqual(slotCell('binary', 3, '010203'), { binary: true, length: 3, preview: '010203' })
  assert.equal(slotCell('plain', null, 12.5), 12.5)
  assert.equal(slotCell('datetime', null, '2026-10-14 08:30:00'), '2026-10-14T08:30:00')
  assert.deepEqual(slotCell('text', 7, { a: 1 }), { a: 1 })
})

test('checkConsoleSql accepts one statement and strips trailing semicolons', () => {
  assert.equal(checkConsoleSql('  SELECT 1;; \n', 'postgres'), 'SELECT 1')
  assert.equal(checkConsoleSql('SELECT 1 -- note', 'mysql'), 'SELECT 1 -- note')
})

test('checkConsoleSql refuses empty input, several statements and NUL', () => {
  for (const sql of ['', '   ', ';', null, 42]) {
    assert.throws(() => checkConsoleSql(sql, 'postgres'), (err) => err.status === 400, String(sql))
  }
  assert.throws(() => checkConsoleSql('SELECT 1; DELETE FROM t', 'postgres'), /one statement/)
  assert.throws(() => checkConsoleSql("SELECT ';'", 'mysql'), /one statement/)
  assert.throws(() => checkConsoleSql('SELECT 1\0', 'postgres'), /NUL/)
  assert.throws(() => checkConsoleSql('x'.repeat(100001), 'postgres'), /longer than/)
})

test('checkConsoleSql refuses psql backslash commands', () => {
  for (const sql of ['\\! ls', '  \\copy t to /tmp/x', '\\c other']) {
    assert.throws(() => checkConsoleSql(sql, 'postgres'), /psql backslash commands/)
  }
})

test('mysql client commands are recognised at the start and on backslash lines', () => {
  for (const sql of ['system ls', 'SOURCE /etc/passwd', 'tee /tmp/x', 'pager less', '! ls', '\\! ls', 'SELECT 1\n  \\G', 'delimiter //']) {
    assert.equal(isMysqlClientCommand(sql.trim()), true, sql)
    assert.throws(() => checkConsoleSql(sql, 'mysql'), /mysql client commands/, sql)
  }
  // A column called `source` on its own line is ordinary SQL
  assert.equal(isMysqlClientCommand('SELECT id,\n  source\nFROM t'), false)
  assert.equal(isMysqlClientCommand('SELECT systems FROM t'), false)
})

test('intParam accepts whole numbers in range only', () => {
  const spec = { label: 'Rows per page', min: 1, max: 200, def: 50 }
  assert.equal(intParam(undefined, spec), 50)
  assert.equal(intParam('', spec), 50)
  assert.equal(intParam('200', spec), 200)
  assert.equal(intParam(7, spec), 7)
  for (const bad of ['0', '201', '-1', '1.5', 'abc', '1e3', ' 5']) {
    assert.throws(() => intParam(bad, spec), (err) => err.status === 400, bad)
  }
})
