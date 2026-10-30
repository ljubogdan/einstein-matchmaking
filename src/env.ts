// Loads .env into process.env when it exists. Import first in every entry point.
// Replay runs and fresh clones have no .env, so a missing file is fine.
try {
  process.loadEnvFile()
} catch {
  // no .env
}
