import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { parseServerPort, serverBaseUrl } from '../src/background/serverUrl.ts'

describe('parseServerPort', () => {
  it('accepts valid ports as numbers or digit strings', () => {
    assert.equal(parseServerPort(5700), 5700)
    assert.equal(parseServerPort(' 5700 '), 5700)
    assert.equal(parseServerPort('1'), 1)
    assert.equal(parseServerPort('65535'), 65535)
  })

  it('rejects blank, out-of-range and non-numeric input', () => {
    for (const value of [
      undefined,
      null,
      '',
      '0',
      '65536',
      '-1',
      '56.5',
      '5600abc',
      'localhost:5700',
      NaN,
    ]) {
      assert.equal(parseServerPort(value), undefined, String(value))
    }
  })
})

describe('serverBaseUrl', () => {
  it('keeps the existing defaults when no port is stored', () => {
    assert.equal(serverBaseUrl(undefined, false), 'http://127.0.0.1:5600')
    assert.equal(serverBaseUrl(undefined, true), 'http://127.0.0.1:5666')
  })

  it('uses a stored port, always on loopback', () => {
    assert.equal(serverBaseUrl(5700, false), 'http://127.0.0.1:5700')
    assert.equal(serverBaseUrl(5700, true), 'http://127.0.0.1:5700')
  })

  it('falls back to the default for an invalid stored value', () => {
    assert.equal(
      serverBaseUrl('evil.example:80', false),
      'http://127.0.0.1:5600',
    )
    assert.equal(serverBaseUrl(70000, false), 'http://127.0.0.1:5600')
  })
})
