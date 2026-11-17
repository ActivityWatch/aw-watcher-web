// The extension only ever talks to a loopback server. Only the port is
// configurable (for example, one ActivityWatch instance per OS user on a
// shared machine); the host is intentionally fixed to 127.0.0.1.
export const DEFAULT_PORT = 5600
export const TESTING_PORT = 5666

/** Returns a valid TCP port (1-65535), or undefined for blank/invalid input. */
export function parseServerPort(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !/^\d+$/.test(text.trim())) return undefined
  const port = Number(text.trim())
  return port >= 1 && port <= 65535 ? port : undefined
}

export function serverBaseUrl(port: unknown, testing: boolean): string {
  const configured = parseServerPort(port)
  const effective = configured ?? (testing ? TESTING_PORT : DEFAULT_PORT)
  return `http://127.0.0.1:${effective}`
}
