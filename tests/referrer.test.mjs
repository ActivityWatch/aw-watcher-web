// Regression tests for the opt-in referrer field (data.referrer, #216).
// Production sources under src/background are transpiled with TypeScript into
// a temporary directory and run unmodified; only the browser, storage, client,
// config and aw-client modules are replaced with in-memory stubs.
//
// Run with: node --test tests/referrer.test.mjs
import { after, afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const SRC_DIR = fileURLToPath(new URL('../src/background/', import.meta.url))
const require = createRequire(import.meta.url)

// `scripting` mimics Manifest V3; set it to undefined to mimic Firefox's
// Manifest V2, where only tabs.executeScript is available.
const STUB_BROWSER = `
export const state = {
  tabs: [],
  activeTabId: undefined,
  manifestVersion: 3,
  granted: true,
  permissionQueries: [],
  injections: [],
  page: undefined,
}
const browser = {
  tabs: {
    get: async (id) => {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) throw new Error('No tab with id ' + id)
      return tab
    },
    query: async (query = {}) =>
      query.active
        ? state.tabs.filter((t) => t.id === state.activeTabId)
        : [...state.tabs],
    executeScript: async (tabId, details) => {
      state.injections.push({ api: 'tabs', tabId, details })
      return [await state.page(tabId)]
    },
  },
  scripting: {
    executeScript: async (injection) => {
      state.injections.push({ api: 'scripting', injection })
      return [{ frameId: 0, result: await state.page(injection.target.tabId) }]
    },
  },
  permissions: {
    contains: async (permissions) => {
      state.permissionQueries.push(permissions)
      return state.granted
    },
  },
  runtime: {
    getURL: (path) => path,
    getManifest: () => ({ manifest_version: state.manifestVersion }),
  },
  notifications: { create: () => {} },
}
export default browser
`

const STUB_STORAGE = `
export const state = {
  enabled: true,
  referrerEnabled: true,
  heartbeatData: undefined,
}
export const getEnabled = async () => state.enabled
export const getProfileName = async () => undefined
export const getReferrerEnabled = async () => state.referrerEnabled
export const getHeartbeatData = async () => state.heartbeatData
export const setHeartbeatData = async (data) => {
  state.heartbeatData = data
}
export const getBrowserName = async () => 'chrome'
export const getBrowserNameUserSelected = async () => false
export const setBrowserName = async () => {}
`

const STUB_CLIENT = `
export const sent = []
export const getBucketId = async () => 'bucket'
export const sendHeartbeat = async (client, bucketId, timestamp, data, pulsetime) => {
  sent.push({ timestamp, data: structuredClone(data), pulsetime })
}
`

const STUB_CONFIG = `
export default { heartbeat: { alarmName: 'heartbeat', intervalInSeconds: 60 } }
`

const STUB_AW_CLIENT = `
export class FetchError extends Error {}
`

const MODULE_MAP = {
    'webextension-polyfill': './stub-browser.mjs',
    'aw-client': './stub-aw-client.mjs',
    '../config': './stub-config.mjs',
    './client': './stub-client.mjs',
    '../storage': './stub-storage.mjs',
    './helpers': './helpers.mjs',
    'deep-equal': pathToFileURL(require.resolve('deep-equal')).href,
    'punycode.js': pathToFileURL(require.resolve('punycode.js')).href,
}

function transpile(source, fileName) {
    return ts.transpileModule(source, {
        fileName,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            isolatedModules: true,
        },
    }).outputText
}

function rewriteImports(js) {
    return js.replace(
        /(\bfrom\s+|\bimport\s+)(['"])([^'"]+)\2/g,
        (_, kw, q, spec) => {
            if (!(spec in MODULE_MAP)) {
                throw new Error(`Unmapped import in production code: ${spec}`)
            }
            return `${kw}${q}${MODULE_MAP[spec]}${q}`
        },
    )
}

async function loadFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'aw-referrer-'))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
        const stubs = {
            'stub-browser.mjs': STUB_BROWSER,
            'stub-storage.mjs': STUB_STORAGE,
            'stub-client.mjs': STUB_CLIENT,
            'stub-config.mjs': STUB_CONFIG,
            'stub-aw-client.mjs': STUB_AW_CLIENT,
        }
        for (const [name, source] of Object.entries(stubs)) {
            await writeFile(join(dir, name), source)
        }
        for (const name of ['helpers', 'heartbeat']) {
            const source = await readFile(join(SRC_DIR, `${name}.ts`), 'utf8')
            const js = rewriteImports(transpile(source, `${name}.ts`))
            await writeFile(join(dir, `${name}.mjs`), js)
        }
        const load = (name) => import(pathToFileURL(join(dir, name)).href)
        return {
            cleanup,
            heartbeat: await load('heartbeat.mjs'),
            helpers: await load('helpers.mjs'),
            browser: await load('stub-browser.mjs'),
            storage: await load('stub-storage.mjs'),
            client: await load('stub-client.mjs'),
        }
    } catch (error) {
        await cleanup()
        throw error
    }
}

const fixture = await loadFixture()
const { heartbeat, helpers, browser, storage, client } = fixture
after(() => fixture.cleanup())

const CLIENT = {}
const PAGE_URL = 'https://example.com/article?id=1'
const REFERRER = 'https://search.example/?q=activitywatch'
const BASE = {
    url: PAGE_URL,
    title: 'Example',
    audible: false,
    incognito: false,
    tabCount: 1,
}

const browserApi = browser.default
const scriptingApi = browserApi.scripting

function useTab(overrides = {}) {
    const tab = {
        id: 1,
        url: PAGE_URL,
        title: 'Example',
        audible: false,
        incognito: false,
        ...overrides,
    }
    browser.state.tabs = [tab]
    browser.state.activeTabId = tab.id
    return tab
}

function sentData() {
    return client.sent.map((entry) => entry.data)
}

beforeEach(() => {
    mock.method(console, 'debug', () => {})
    mock.method(console, 'warn', () => {})
    mock.method(console, 'error', () => {})
    client.sent.length = 0
    Object.assign(storage.state, {
        enabled: true,
        referrerEnabled: true,
        heartbeatData: undefined,
    })
    Object.assign(browser.state, {
        tabs: [],
        activeTabId: undefined,
        manifestVersion: 3,
        granted: true,
        permissionQueries: [],
        injections: [],
        page: async () => ({ url: PAGE_URL, referrer: REFERRER }),
    })
    browserApi.scripting = scriptingApi
})

afterEach(() => {
    mock.restoreAll()
})

test('referrer is omitted while the setting is off and no script runs', async () => {
    storage.state.referrerEnabled = false
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])
    assert.deepEqual(browser.state.injections, [])
    assert.deepEqual(browser.state.permissionQueries, [])
})

test('enabled setting adds data.referrer read via scripting on MV3', async () => {
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [{ ...BASE, referrer: REFERRER }])
    assert.deepEqual(browser.state.permissionQueries, [
        { permissions: ['scripting'] },
    ])
    const [{ api, injection }] = browser.state.injections
    assert.equal(api, 'scripting')
    assert.deepEqual(injection.target, { tabId: 1 })
    assert.equal(injection.injectImmediately, true)
})

test('Firefox MV2 falls back to tabs.executeScript with host access', async () => {
    browser.state.manifestVersion = 2
    browserApi.scripting = undefined
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [{ ...BASE, referrer: REFERRER }])
    assert.deepEqual(browser.state.permissionQueries, [
        { origins: ['<all_urls>'] },
    ])
    const [{ api, tabId, details }] = browser.state.injections
    assert.equal(api, 'tabs')
    assert.equal(tabId, 1)
    assert.equal(details.runAt, 'document_start')
})

test('missing permission skips the injection', async () => {
    browser.state.granted = false
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])
    assert.deepEqual(browser.state.injections, [])
})

test('pages without a referrer send the unchanged event', async () => {
    browser.state.page = async () => ({ url: PAGE_URL, referrer: '' })
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])
})

test('pages that cannot be scripted send the unchanged event', async () => {
    browser.state.page = async () => {
        throw new Error('Cannot access a chrome:// PAGE_URL')
    }
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])
})

test('a result from a different document is discarded', async () => {
    browser.state.page = async () => ({
        url: 'https://previous.example/',
        referrer: 'https://stale.example/',
    })
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])
})

test('malformed script results are ignored', async () => {
    browser.state.page = async () => undefined
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])
})

test('a stalled page times out without blocking later heartbeats', async () => {
    mock.timers.enable({ apis: ['setTimeout'] })
    browser.state.page = () => new Promise(() => {})
    useTab()
    const pending = heartbeat.sendInitialHeartbeat(CLIENT)
    // Let the queued heartbeat reach the injection before advancing time.
    for (let i = 0; i < 20 && browser.state.injections.length === 0; i++) {
        await new Promise((resolve) => setImmediate(resolve))
    }
    assert.equal(browser.state.injections.length, 1)
    mock.timers.tick(1000)
    await pending
    assert.deepEqual(sentData(), [BASE])
})

test('tab updates read the referrer of the updated tab', async () => {
    const tab = useTab({ id: 5 })
    await heartbeat.tabUpdatedListener(CLIENT)(tab.id, { url: tab.url }, tab)
    assert.deepEqual(sentData(), [{ ...BASE, referrer: REFERRER }])
    assert.deepEqual(browser.state.injections[0].injection.target, {
        tabId: 5,
    })
})

test('a stable referrer keeps consecutive heartbeats mergeable', async () => {
    useTab()
    await heartbeat.sendInitialHeartbeat(CLIENT)
    await heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    // No "previous data" flush is sent when nothing changed.
    assert.equal(client.sent.length, 2)
    assert.deepEqual(sentData(), [
        { ...BASE, referrer: REFERRER },
        { ...BASE, referrer: REFERRER },
    ])
})

test('getReferrerPermissions matches the manifest version', () => {
    browser.state.manifestVersion = 3
    assert.deepEqual(helpers.getReferrerPermissions(), {
        permissions: ['scripting'],
    })
    browser.state.manifestVersion = 2
    assert.deepEqual(helpers.getReferrerPermissions(), {
        origins: ['<all_urls>'],
    })
})
