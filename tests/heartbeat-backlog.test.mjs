// Regression tests for ActivityWatch/aw-watcher-web#284: while the server is
// slow or down, sendHeartbeat's retries hold the heartbeat queue, so a queued
// heartbeat can run long after its event fired. It must still describe the tab
// active when the event fired, not the tab active when the task finally runs.
// Loader copied from tab-groups.test.mjs: production sources under
// src/background are transpiled with TypeScript into a temporary directory and
// run unmodified; only the browser, storage, client, config and aw-client
// modules are replaced with in-memory stubs.
//
// Run with: node --test tests/heartbeat-backlog.test.mjs
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

const STUB_BROWSER = `
export const state = { tabs: [], activeTabId: undefined, fullQueries: 0 }
const browser = {
  tabs: {
    get: async (id) => {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) throw new Error('No tab with id ' + id)
      return tab
    },
    query: async (query = {}) => {
      if (!query.active) state.fullQueries += 1
      return query.active
        ? state.tabs.filter((t) => t.id === state.activeTabId)
        : [...state.tabs]
    },
  },
  runtime: { getURL: (path) => path },
  notifications: { create: () => {} },
}
export default browser
`

const STUB_STORAGE = `
export const state = {
  enabled: true,
  profile: undefined,
  heartbeatData: undefined,
  browserName: 'chrome',
  browserNameUserSelected: false,
}
export const getEnabled = async () => state.enabled
export const getProfileName = async () => state.profile
export const getHeartbeatData = async () => state.heartbeatData
export const setHeartbeatData = async (data) => {
  state.heartbeatData = data
}
export const getBrowserName = async () => state.browserName
export const getBrowserNameUserSelected = async () => state.browserNameUserSelected
export const setBrowserName = async (name) => {
  state.browserName = name
}
`

const STUB_CLIENT = `
export const sent = []
export const getBucketId = async () => 'bucket'
export const hooks = { beforeSend: undefined }
export const sendHeartbeat = async (client, bucketId, timestamp, data, pulsetime) => {
  if (hooks.beforeSend) await hooks.beforeSend({ timestamp, data })
  sent.push({ timestamp, data: structuredClone(data), pulsetime })
}
`

const STUB_CONFIG = `
export default { heartbeat: { alarmName: 'heartbeat', intervalInSeconds: 60 } }
`

const STUB_AW_CLIENT = `
export class FetchError extends Error {}
`

// Production import specifier -> specifier to use in the transpiled fixture.
const MODULE_MAP = {
    'webextension-polyfill': './stub-browser.mjs',
    'aw-client': './stub-aw-client.mjs',
    '../config': './stub-config.mjs',
    './client': './stub-client.mjs',
    '../storage': './stub-storage.mjs',
    './helpers': './helpers.mjs',
    './browserFork': './browserFork.mjs',
    'deep-equal': pathToFileURL(require.resolve('deep-equal')).href,
    // punycode.js is CJS with no detectable named exports, so a namespace
    // import has no toUnicode under Node; re-export it like the bundler does.
    'punycode.js': './stub-punycode.mjs',
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
    const dir = await mkdtemp(join(tmpdir(), 'aw-remaining-findings-'))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
        const stubs = {
            'stub-browser.mjs': STUB_BROWSER,
            'stub-storage.mjs': STUB_STORAGE,
            'stub-client.mjs': STUB_CLIENT,
            'stub-config.mjs': STUB_CONFIG,
            'stub-aw-client.mjs': STUB_AW_CLIENT,
            'stub-punycode.mjs': `import p from '${pathToFileURL(require.resolve('punycode.js')).href}'\nexport const toUnicode = p.toUnicode\n`,
        }
        for (const [name, source] of Object.entries(stubs)) {
            await writeFile(join(dir, name), source)
        }
        for (const name of ['helpers', 'heartbeat', 'browserFork']) {
            const source = await readFile(
                join(SRC_DIR, `${name}.ts`),
                'utf8',
            ).catch((error) => {
                if (name === 'browserFork' && error.code === 'ENOENT')
                    return undefined
                throw error
            })
            if (source === undefined) continue
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
const { heartbeat, browser, storage, client } = fixture
after(() => fixture.cleanup())

const CLIENT = {}

function makeTab(overrides = {}) {
    return {
        id: 1,
        url: 'https://example.com/',
        title: 'Example',
        audible: false,
        incognito: false,
        groupId: -1,
        ...overrides,
    }
}

function deferred() {
    let resolve
    const promise = new Promise((r) => {
        resolve = r
    })
    return { promise, resolve }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

beforeEach(() => {
    mock.method(console, 'debug', () => {})
    mock.method(console, 'warn', () => {})
    mock.method(console, 'error', () => {})
    client.sent.length = 0
    client.hooks.beforeSend = undefined
    Object.assign(storage.state, {
        enabled: true,
        profile: undefined,
        heartbeatData: undefined,
    })
    browser.state.tabs = []
    browser.state.activeTabId = undefined
    delete globalThis.chrome
})

afterEach(() => {
    mock.restoreAll()
    mock.timers.reset()
})

test('a backlogged alarm heartbeat carries the tab active at its timestamp', async () => {
    const T0 = Date.parse('2026-01-01T00:00:00Z')
    mock.timers.enable({ apis: ['Date'], now: T0 })

    const a = makeTab({ id: 1, url: 'https://a.test/', title: 'A' })
    const b = makeTab({ id: 2, url: 'https://b.test/', title: 'B' })
    browser.state.tabs = [a, b]
    browser.state.activeTabId = a.id
    await heartbeat.sendInitialHeartbeat(CLIENT) // A @ T0, server healthy

    // Server goes slow: the next send blocks until we release the gate.
    const gate = deferred()
    client.hooks.beforeSend = async () => {
        client.hooks.beforeSend = undefined
        await gate.promise
    }

    mock.timers.setTime(T0 + 60_000)
    const alarm1 = heartbeat.heartbeatAlarmListener(CLIENT)({
        name: 'heartbeat',
    })
    await tick() // alarm1 now stuck inside sendHeartbeat

    // A is still active when the second alarm fires.
    const T2 = T0 + 120_000
    mock.timers.setTime(T2)
    const alarm2 = heartbeat.heartbeatAlarmListener(CLIENT)({
        name: 'heartbeat',
    })
    await tick()

    // A new tab opens after T2; the queued alarm must retain the old count.
    browser.state.tabs.push(makeTab({ id: 3 }))

    // User switches to B afterwards, while the queue is still backed up.
    mock.timers.setTime(T0 + 130_000)
    browser.state.activeTabId = b.id
    const activated = heartbeat.tabActivatedListener(CLIENT)({ tabId: b.id })
    await tick()

    gate.resolve()
    await Promise.all([alarm1, alarm2, activated])

    const atT2 = client.sent.filter((e) => e.timestamp.getTime() === T2)
    assert.equal(atT2.length, 1)
    assert.equal(
        atT2[0].data.url,
        'https://a.test/',
        'heartbeat stamped T2 must describe the tab active at T2 (A)',
    )
    assert.equal(atT2[0].data.tabCount, 2)
})

test('a backlogged tab activation carries the tab as it was when activated', async () => {
    const T0 = Date.parse('2026-01-01T00:00:00Z')
    mock.timers.enable({ apis: ['Date'], now: T0 })

    const a = makeTab({ id: 1, url: 'https://a.test/', title: 'A' })
    const b = makeTab({ id: 2, url: 'https://b.test/', title: 'B' })
    browser.state.tabs = [a, b]
    browser.state.activeTabId = a.id
    await heartbeat.sendInitialHeartbeat(CLIENT)

    const gate = deferred()
    client.hooks.beforeSend = async () => {
        client.hooks.beforeSend = undefined
        await gate.promise
    }

    mock.timers.setTime(T0 + 60_000)
    const alarm = heartbeat.heartbeatAlarmListener(CLIENT)({
        name: 'heartbeat',
    })
    await tick() // stuck inside sendHeartbeat

    const T1 = T0 + 70_000
    mock.timers.setTime(T1)
    browser.state.activeTabId = b.id
    const activated = heartbeat.tabActivatedListener(CLIENT)({ tabId: b.id })
    await tick()

    // B navigates while the queue is still backed up.
    mock.timers.setTime(T0 + 100_000)
    b.url = 'https://b.test/later'
    b.title = 'B later'

    gate.resolve()
    await Promise.all([alarm, activated])

    const atT1 = client.sent.filter((e) => e.timestamp.getTime() === T1)
    assert.equal(atT1.length, 1)
    assert.equal(atT1[0].data.url, 'https://b.test/')
    assert.equal(atT1[0].data.title, 'B')
})

for (const kind of ['alarm', 'activation', 'update']) {
    test(`a ${kind} event fired while paused is dropped after tracking resumes`, async () => {
        const T0 = Date.parse('2026-01-01T00:00:00Z')
        mock.timers.enable({ apis: ['Date'], now: T0 })
        const a = makeTab({ id: 1 })
        const b = makeTab({
            id: 2,
            url: 'https://private.test/',
            title: 'Paused',
        })
        browser.state.tabs = [a, b]
        browser.state.activeTabId = a.id
        await heartbeat.sendInitialHeartbeat(CLIENT)
        const gate = deferred()
        client.hooks.beforeSend = async () => {
            client.hooks.beforeSend = undefined
            await gate.promise
        }
        mock.timers.setTime(T0 + 60_000)
        const blocked = heartbeat.heartbeatAlarmListener(CLIENT)({
            name: 'heartbeat',
        })
        await tick()
        storage.state.enabled = false
        browser.state.activeTabId = b.id
        const pausedTime = T0 + 70_000
        mock.timers.setTime(pausedTime)
        const paused =
            kind === 'alarm'
                ? heartbeat.heartbeatAlarmListener(CLIENT)({
                      name: 'heartbeat',
                  })
                : kind === 'activation'
                  ? heartbeat.tabActivatedListener(CLIENT)({ tabId: b.id })
                  : heartbeat.tabUpdatedListener(CLIENT)(
                        b.id,
                        { title: b.title },
                        b,
                    )
        await tick()
        storage.state.enabled = true
        gate.resolve()
        await Promise.all([blocked, paused])
        assert.equal(
            client.sent.filter((e) => e.timestamp.getTime() === pausedTime)
                .length,
            0,
        )
        assert.equal(
            client.sent.some((e) => e.data.url === b.url),
            false,
        )
    })
}

test('hostname detection delays transmission while preserving the event tab', async () => {
    const T0 = Date.parse('2026-01-01T00:00:00Z')
    mock.timers.enable({ apis: ['Date'], now: T0 })
    const tab = makeTab({ url: 'https://before.test/', title: 'Before' })
    browser.state.tabs = [tab]
    browser.state.activeTabId = tab.id
    const gate = deferred()
    const pending = heartbeat.tabActivatedListener(
        CLIENT,
        gate.promise,
    )({ tabId: tab.id })
    await tick()
    assert.equal(client.sent.length, 0)
    tab.url = 'https://later.test/'
    tab.title = 'Later'
    mock.timers.setTime(T0 + 5000)
    gate.resolve()
    await pending
    assert.equal(client.sent.length, 1)
    assert.equal(client.sent[0].timestamp.getTime(), T0)
    assert.equal(client.sent[0].data.url, 'https://before.test/')
})

test('a background tab update stays ignored when activation changes during readiness', async () => {
    const a = makeTab({ id: 1, url: 'https://a.test/' })
    const b = makeTab({ id: 2, url: 'https://background.test/' })
    browser.state.tabs = [a, b]
    browser.state.activeTabId = a.id
    const gate = deferred()
    const first = heartbeat.tabActivatedListener(
        CLIENT,
        gate.promise,
    )({ tabId: a.id })
    await tick()
    const update = heartbeat.tabUpdatedListener(CLIENT, gate.promise)(
        b.id,
        { title: b.title },
        b,
    )
    await tick()
    browser.state.activeTabId = b.id
    gate.resolve()
    await Promise.all([first, update])
    assert.equal(
        client.sent.some((e) => e.data.url === b.url),
        false,
    )
})

test('a background tab update does not scan every open tab', async () => {
    const a = makeTab({ id: 1, url: 'https://a.test/' })
    const b = makeTab({ id: 2, url: 'https://background.test/' })
    browser.state.tabs = [a, b]
    browser.state.activeTabId = a.id
    browser.state.fullQueries = 0
    await heartbeat.tabUpdatedListener(CLIENT)(b.id, { title: b.title }, b)
    assert.equal(browser.state.fullQueries, 0)
    assert.equal(client.sent.length, 0)

    await heartbeat.tabUpdatedListener(CLIENT)(a.id, { title: a.title }, a)
    assert.equal(browser.state.fullQueries, 1)
    assert.equal(client.sent.length, 1)
})
