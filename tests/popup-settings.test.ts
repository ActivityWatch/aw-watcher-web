import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { openSettingsPage, SETTINGS_PAGE_PATH } from '../src/popup/settings.ts'

const getURL = (path: string) => `chrome-extension://id/${path}`

describe('openSettingsPage', () => {
  it('uses openOptionsPage when it succeeds', async () => {
    const tabs: unknown[] = []
    let calls = 0
    await openSettingsPage({
      openOptionsPage: async () => {
        calls += 1
      },
      getURL,
      createTab: async (properties) => tabs.push(properties),
    })
    assert.equal(calls, 1)
    assert.deepEqual(tabs, [])
  })

  it('opens the settings page in a tab when openOptionsPage rejects', async () => {
    const tabs: unknown[] = []
    const originalWarn = console.warn
    console.warn = () => {}
    try {
      await openSettingsPage({
        openOptionsPage: async () => {
          throw new Error('Could not create an options page.')
        },
        getURL,
        createTab: async (properties) => tabs.push(properties),
      })
    } finally {
      console.warn = originalWarn
    }
    assert.deepEqual(tabs, [{ active: true, url: getURL(SETTINGS_PAGE_PATH) }])
  })

  it('opens the settings page in a tab when openOptionsPage is unavailable', async () => {
    const tabs: unknown[] = []
    await openSettingsPage({
      getURL,
      createTab: async (properties) => tabs.push(properties),
    })
    assert.deepEqual(tabs, [{ active: true, url: getURL(SETTINGS_PAGE_PATH) }])
  })

  it('matches the options_ui page declared in the manifest', async () => {
    const { readFile } = await import('node:fs/promises')
    const manifest = JSON.parse(
      await readFile(new URL('../src/manifest.json', import.meta.url), 'utf8'),
    )
    assert.equal(manifest.options_ui.page, SETTINGS_PAGE_PATH)
  })
})
