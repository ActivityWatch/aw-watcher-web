import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { forkBucketFromBrowserInfo } from '../src/background/browserFork.ts'

describe('forkBucketFromBrowserInfo', () => {
  it('detects Zen from its info field even though it reports Firefox', () => {
    assert.equal(
      forkBucketFromBrowserInfo({
        name: 'Firefox',
        zen: { version: '1.22.3b' },
      }),
      'zen',
    )
  })

  it('detects Floorp by exact name or first word', () => {
    assert.equal(forkBucketFromBrowserInfo({ name: 'Floorp' }), 'floorp')
    assert.equal(
      forkBucketFromBrowserInfo({ name: 'Floorp Browser' }),
      'floorp',
    )
    assert.equal(forkBucketFromBrowserInfo({ name: 'Zen Browser' }), 'zen')
  })

  it('does not match fork names as substrings', () => {
    for (const name of ['Zenith', 'Gozen', 'Citizen Browser', 'NotFloorp']) {
      assert.equal(forkBucketFromBrowserInfo({ name }), 'firefox', name)
    }
  })

  it('falls back to firefox for plain Firefox, other forks and bad input', () => {
    for (const info of [
      { name: 'Firefox' },
      { name: 'LibreWolf' },
      { name: '' },
      { zen: {} },
      undefined,
      null,
    ]) {
      assert.equal(forkBucketFromBrowserInfo(info), 'firefox')
    }
  })
})
