import assert from 'node:assert/strict'
import test from 'node:test'
import { loadModule } from './load-module.mjs'

for (const [name, policy, expected] of [
    ['explicit acceptance', { consentOfflineDataCollection: true }, false],
    ['explicit refusal', { consentOfflineDataCollection: false }, true],
    ['missing policy', {}, true],
    ['malformed policy', { consentOfflineDataCollection: 'true' }, true],
]) {
    test(`Firefox consent: ${name}`, async () => {
        const { getIsConsentRequired } = loadModule(
            'src/background/consent.ts',
            {
                '../config': { requireConsent: true },
                'webextension-polyfill': {
                    storage: { managed: { get: async () => policy } },
                },
            },
        )
        assert.equal(await getIsConsentRequired(), expected)
    })
}

test('unavailable managed storage requires consent', async () => {
    const { getIsConsentRequired } = loadModule('src/background/consent.ts', {
        '../config': { requireConsent: true },
        'webextension-polyfill': {
            storage: {
                managed: {
                    get: async () => {
                        throw Error('Unavailable')
                    },
                },
            },
        },
    })
    assert.equal(await getIsConsentRequired(), true)
})

test('browsers without a consent requirement do not query managed storage', async () => {
    const { getIsConsentRequired } = loadModule('src/background/consent.ts', {
        '../config': { requireConsent: false },
        'webextension-polyfill': {},
    })
    assert.equal(await getIsConsentRequired(), false)
})
