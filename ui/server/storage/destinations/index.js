const store = require('./store')

// Provider registry. A provider implements:
//   validateConfig(input, currentConfig) -> config
//   upload(dest, file, name)             -> { key, bucket } | { fileId }
//   download(dest, location, outFile)
//   remove(dest, location)
//   test(dest)                           -> { ok, message }
const providers = {
  s3: require('./s3'),
  gdrive: require('./gdrive'),
}

/** Provider for a destination type (throws on unknown types). */
function getProvider(type) {
  const provider = providers[type]
  if (!provider) throw new Error(`Unknown destination type: ${type}`)
  return provider
}

/** Test helper: replace a provider implementation. */
function setProviderForTests(type, impl) {
  providers[type] = impl
}

module.exports = { ...store, getProvider, setProviderForTests }
