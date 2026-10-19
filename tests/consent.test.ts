import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getIsConsentRequired,
  installAction,
  isManagedConsentGranted,
  type ManagedConsentResult,
} from '../src/background/consent.ts'

const resolveWith =
  (value: ManagedConsentResult) => async (): Promise<ManagedConsentResult> =>
    value

describe('isManagedConsentGranted', () => {
  it('does not grant consent for an empty managed result', () => {
    assert.equal(isManagedConsentGranted({}), false)
  })

  it('does not grant consent for an explicit false policy', () => {
    assert.equal(
      isManagedConsentGranted({ consentOfflineDataCollection: false }),
      false,
    )
  })

  it('grants consent for an explicit true policy', () => {
    assert.equal(
      isManagedConsentGranted({ consentOfflineDataCollection: true }),
      true,
    )
  })

  it('does not grant consent for malformed or unrelated values', () => {
    assert.equal(
      isManagedConsentGranted({ consentOfflineDataCollection: 'true' }),
      false,
    )
    assert.equal(
      isManagedConsentGranted({ consentOfflineDataCollection: 1 }),
      false,
    )
    assert.equal(isManagedConsentGranted({ otherPolicy: true }), false)
    assert.equal(isManagedConsentGranted(null), false)
    assert.equal(isManagedConsentGranted(undefined), false)
  })
})

describe('getIsConsentRequired', () => {
  it('never requires consent on Chromium and does not read managed policy', async () => {
    let reads = 0
    const required = await getIsConsentRequired(false, async () => {
      reads += 1
      throw new Error('managed storage should not be read')
    })
    assert.equal(required, false)
    assert.equal(reads, 0)
  })

  it('requires consent when the managed result is absent', async () => {
    assert.equal(await getIsConsentRequired(true, resolveWith({})), true)
  })

  it('requires consent when managed policy sets the boolean false', async () => {
    assert.equal(
      await getIsConsentRequired(
        true,
        resolveWith({ consentOfflineDataCollection: false }),
      ),
      true,
    )
  })

  it('does not require consent when managed policy sets the boolean true', async () => {
    assert.equal(
      await getIsConsentRequired(
        true,
        resolveWith({ consentOfflineDataCollection: true }),
      ),
      false,
    )
  })

  it('requires consent for malformed managed values', async () => {
    assert.equal(
      await getIsConsentRequired(
        true,
        resolveWith({ consentOfflineDataCollection: 'true' }),
      ),
      true,
    )
  })

  it('requires consent when reading managed storage rejects', async () => {
    assert.equal(
      await getIsConsentRequired(true, async () => {
        throw new Error('managed storage unavailable')
      }),
      true,
    )
  })
})

describe('installAction', () => {
  it('shows the consent page when consent is required and not yet stored', () => {
    assert.equal(installAction(true, undefined), 'show-consent')
    assert.equal(installAction(true, false), 'show-consent')
  })

  it('enables when consent is required but already stored', () => {
    assert.equal(installAction(true, true), 'enable')
  })

  it('enables when consent is not required, regardless of stored consent', () => {
    assert.equal(installAction(false, undefined), 'enable')
    assert.equal(installAction(false, false), 'enable')
    assert.equal(installAction(false, true), 'enable')
  })
})

// Mirrors the onInstalled listener's decision branch so the regression covers
// the install-flow effect (enable collection vs. open the consent page), not
// only the individual helpers.
async function runInstallGate(
  requireConsent: boolean,
  readManaged: () => Promise<ManagedConsentResult>,
  storedConsent: boolean | undefined,
): Promise<'setEnabled(true)' | 'open-consent-page'> {
  const isConsentRequired = await getIsConsentRequired(
    requireConsent,
    readManaged,
  )
  return installAction(isConsentRequired, storedConsent) === 'enable'
    ? 'setEnabled(true)'
    : 'open-consent-page'
}

describe('Firefox install gate', () => {
  it('does not enable collection for an empty managed policy without user consent', async () => {
    assert.equal(
      await runInstallGate(true, resolveWith({}), undefined),
      'open-consent-page',
    )
  })

  it('does not enable collection for an explicit false managed policy without user consent', async () => {
    assert.equal(
      await runInstallGate(
        true,
        resolveWith({ consentOfflineDataCollection: false }),
        undefined,
      ),
      'open-consent-page',
    )
  })

  it('enables collection for an explicit true managed policy', async () => {
    assert.equal(
      await runInstallGate(
        true,
        resolveWith({ consentOfflineDataCollection: true }),
        undefined,
      ),
      'setEnabled(true)',
    )
  })

  it('enables collection for stored user consent', async () => {
    assert.equal(
      await runInstallGate(true, resolveWith({}), true),
      'setEnabled(true)',
    )
  })

  it('keeps consent required when the managed read fails', async () => {
    assert.equal(
      await runInstallGate(
        true,
        async () => {
          throw new Error('managed storage unavailable')
        },
        undefined,
      ),
      'open-consent-page',
    )
  })

  it('leaves the Chromium install path unchanged', async () => {
    assert.equal(
      await runInstallGate(false, resolveWith({}), undefined),
      'setEnabled(true)',
    )
  })
})
