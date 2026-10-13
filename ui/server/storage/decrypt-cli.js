#!/usr/bin/env node
// Offline decryption of encrypted backups (*.enc) for disaster recovery.
// Works without the web server, its database or node_modules: it only needs
// this file and crypto-format.js (Node.js >= 18).
//
// Usage:
//   BACKUP_ENCRYPTION_PASSPHRASE='…' node decrypt-cli.js [--gunzip] <in.enc> <out>
//   printf '%s' '…' | node decrypt-cli.js [--gunzip] <in.enc> <out>
//   node decrypt-cli.js <in.enc> <out>        (prompts for the passphrase)
//
// --gunzip  also decompress (for *.sql.gz.enc → plain .sql in one step)
//
// The output file is only kept when the authentication tag verifies.
const fs = require('fs')
const zlib = require('zlib')
const readline = require('readline')
const { pipeline } = require('stream/promises')
const { decryptFile } = require('./crypto-format')

function usage() {
  process.stderr.write('Usage: node decrypt-cli.js [--gunzip] <input.enc> <output>\n'
    + 'Passphrase: env BACKUP_ENCRYPTION_PASSPHRASE, piped on stdin, or typed at the prompt.\n')
  process.exit(2)
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (d) => { data += d })
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')))
    process.stdin.on('error', reject)
  })
}

/** Prompt on the terminal without echoing the passphrase. */
function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true })
    rl._writeToOutput = (s) => { if (s.includes(question)) process.stderr.write(s) }
    rl.question(question, (answer) => { rl.close(); process.stderr.write('\n'); resolve(answer) })
  })
}

async function getPassphrase() {
  if (process.env.BACKUP_ENCRYPTION_PASSPHRASE) return process.env.BACKUP_ENCRYPTION_PASSPHRASE
  if (!process.stdin.isTTY) return readStdin()
  return promptHidden('Passphrase: ')
}

async function main(argv) {
  const gunzip = argv.includes('--gunzip')
  const [input, output] = argv.filter((a) => a !== '--gunzip')
  if (!input || !output) usage()
  if (!fs.existsSync(input)) throw new Error(`Input not found: ${input}`)
  if (fs.existsSync(output)) throw new Error(`Refusing to overwrite existing file: ${output}`)
  const passphrase = await getPassphrase()
  if (!passphrase) throw new Error('Empty passphrase')

  const decrypted = gunzip ? `${output}.decrypting` : output
  await decryptFile(input, decrypted, passphrase)
  if (gunzip) {
    try {
      await pipeline(fs.createReadStream(decrypted), zlib.createGunzip(), fs.createWriteStream(output))
    } catch (err) {
      fs.rmSync(output, { force: true })
      throw err
    } finally {
      fs.rmSync(decrypted, { force: true })
    }
  }
  process.stderr.write(`Decrypted ${input} → ${output} (authentication verified)\n`)
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`)
    process.exit(1)
  })
}

module.exports = { main }
