// Regression tests for optional Chromium tab-group metadata (tab_group and
// tab_group_color). Production sources under src/background are transpiled with
// TypeScript into a temporary directory and run unmodified; only the browser,
// storage, client, config and aw-client modules are replaced with in-memory stubs.
//
// Run with: node --test tests/tab-groups.test.mjs
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
export const state = { tabs: [], activeTabId: undefined, focused: true, local: {} }
const browser = {
  storage: { local: {
    get: async (keys) => Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(state.local[key])]),
    ),
    set: async (values) => { Object.assign(state.local, structuredClone(values)) },
    remove: async (key) => { delete state.local[key] },
  } },
  windows: {
    onFocusChanged: { addListener: () => {} },
    WINDOW_ID_NONE: -1,
    getLastFocused: async () => ({ focused: state.focused }),
  },
  alarms: { create: () => {}, onAlarm: { addListener: () => {} } },
  tabs: {
    onActivated: { addListener: () => {} },
    onUpdated: { addListener: () => {} },
    get: async (id) => {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) throw new Error('No tab with id ' + id)
      return tab
    },
    query: async (query = {}) =>
      query.active
        ? state.tabs.filter((t) => t.id === state.activeTabId)
        : [...state.tabs],
  },
  runtime: {
    getURL: (path) => path,
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
    onMessage: { addListener: () => {} },
  },
  notifications: { create: () => {} },
}
export default browser
`

const STUB_STORAGE = `
export const state = {
  enabled: true,
  pauseWhenUnfocused: false,
  profile: undefined,
  heartbeatData: undefined,
  browserName: 'chrome',
  browserNameUserSelected: false,
}
export const getConsentStatus = async () => ({ consent: true })
export const setConsentStatus = async () => {}
export const setEnabled = async () => {}
export const setHostname = async () => {}
export const setBaseUrl = async () => {}
export const waitForEnabled = async () => { if (state.enableGate) await state.enableGate }
export const getApiKey = async () => undefined
export const getHostname = async () => 'test-host'
export const getSyncStatus = async () => ({ success: true })
export const setSyncStatus = async () => {}
export const getEnabled = async () => state.enabled
export const getPauseWhenUnfocused = async () => {
  if (state.pauseReadGate) await state.pauseReadGate
  return state.pauseWhenUnfocused
}
export const getHeartbeatBoundaryPending = async () => Boolean(state.heartbeatBoundaryPending)
export const setHeartbeatBoundaryPending = async () => { state.heartbeatBoundaryPending = true }
export const clearHeartbeatData = async () => {
  await setHeartbeatBoundaryPending()
  state.heartbeatData = undefined
}
export const getProfileName = async () => state.profile
export const getHeartbeatData = async () => state.heartbeatData
export const setHeartbeatData = async (data) => {
  state.heartbeatData = data
  state.heartbeatBoundaryPending = false
}
export const getBrowserName = async () => state.browserName
export const getBrowserNameUserSelected = async () => state.browserNameUserSelected
export const setBrowserName = async (name) => {
  state.browserName = name
}
`

const STUB_CLIENT = `
export const sent = []
export const getClient = () => ({})
export const loadApiKey = async () => {}
export const detectHostname = async () => 'host'
export const getBucketId = async () => 'bucket'
export const sendHeartbeat = async (client, bucketId, timestamp, data, pulsetime) => {
  if (client.send) await client.send()
  sent.push({ timestamp, data: structuredClone(data), pulsetime })
  return true
}
`

const STUB_CONFIG = `
export default { heartbeat: { alarmName: 'heartbeat', intervalInSeconds: 60 } }
`

const STUB_AW_CLIENT = `
export class FetchError extends Error {}
export class AWClient {}
`

// Production import specifier -> specifier to use in the transpiled fixture.
const MODULE_MAP = {
    'webextension-polyfill': './stub-browser.mjs',
    'aw-client': './stub-aw-client.mjs',
    '../config': './stub-config.mjs',
    './client': './stub-client.mjs',
    '../storage': './stub-storage.mjs',
    './helpers': './helpers.mjs',
    './heartbeat': './heartbeat.mjs',
    './consent': './stub-consent.mjs',
    'p-retry': './fast-retry.mjs',
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

async function loadFixture({
    productionClient = false,
    productionStorage = false,
} = {}) {
    const dir = await mkdtemp(join(tmpdir(), 'aw-tab-groups-'))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
        const stubs = {
            'stub-consent.mjs':
                'export const getIsConsentRequired = () => false; export const installAction = () => "enable"',
            'stub-browser.mjs': STUB_BROWSER,
            'stub-storage.mjs': STUB_STORAGE,
            'stub-client.mjs': STUB_CLIENT,
            'stub-config.mjs': STUB_CONFIG,
            'stub-aw-client.mjs': STUB_AW_CLIENT,
        }
        for (const [name, source] of Object.entries(stubs)) {
            await writeFile(join(dir, name), source)
        }
        // Keep real retry/failure behavior, but do not sleep in offline tests.
        await writeFile(
            join(dir, 'fast-retry.mjs'),
            `
import retry from ${JSON.stringify(pathToFileURL(require.resolve('p-retry')).href)}
export default (fn, options) => retry(fn, { ...options, minTimeout: 0, maxTimeout: 0 })
`,
        )
        for (const name of [
            'helpers',
            'heartbeat',
            'main',
            ...(productionClient ? ['client'] : []),
        ]) {
            const source = await readFile(join(SRC_DIR, `${name}.ts`), 'utf8')
            const js = rewriteImports(
                transpile(source, `${name}.ts`),
            ).replaceAll(
                './stub-client.mjs',
                productionClient ? './client.mjs' : './stub-client.mjs',
            )
            await writeFile(join(dir, `${name}.mjs`), js)
        }
        if (productionStorage) {
            const source = await readFile(
                join(SRC_DIR, '../storage.ts'),
                'utf8',
            )
            await writeFile(
                join(dir, 'stub-storage.mjs'),
                rewriteImports(transpile(source, 'storage.ts')),
            )
        }
        const load = (name) => import(pathToFileURL(join(dir, name)).href)
        return {
            cleanup,
            start: () => load('main.mjs'),
            restartHeartbeat: () =>
                import(
                    `${pathToFileURL(join(dir, 'heartbeat.mjs')).href}?restart=${Math.random()}`
                ),
            heartbeat: await load('heartbeat.mjs'),
            helpers: await load('helpers.mjs'),
            browser: await load('stub-browser.mjs'),
            storage: await load('stub-storage.mjs'),
            client: await load(
                productionClient ? 'client.mjs' : 'stub-client.mjs',
            ),
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
const BASE = {
    url: 'https://example.com/',
    title: 'Example',
    audible: false,
    incognito: false,
    tabCount: 1,
}
const WORK = { tab_group: 'Work', tab_group_color: 'blue' }

let groups
let groupCalls

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

function useTab(tab) {
    browser.state.tabs = [tab]
    browser.state.activeTabId = tab.id
    return tab
}

function sentData() {
    return client.sent.map((entry) => entry.data)
}

function deferred() {
    let resolve
    const promise = new Promise((r) => {
        resolve = r
    })
    return { promise, resolve }
}

function installChromeTabGroups(get) {
    globalThis.chrome = {
        tabGroups: {
            get,
        },
    }
}

beforeEach(async () => {
    mock.method(console, 'debug', () => {})
    mock.method(console, 'warn', () => {})
    mock.method(console, 'error', () => {})
    client.sent.length = 0
    Object.assign(storage.state, {
        enabled: true,
        pauseWhenUnfocused: false,
        pauseReadGate: undefined,
        profile: undefined,
        heartbeatData: undefined,
        heartbeatBoundaryPending: false,
    })
    browser.state.tabs = []
    browser.state.activeTabId = undefined
    browser.state.focused = true
    await heartbeat.refreshWindowFocus()
    groups = new Map([
        [7, { id: 7, title: 'Work', color: 'blue' }],
        [8, { id: 8, title: 'Second', color: 'red' }],
    ])
    groupCalls = []
    installChromeTabGroups(async (id) => {
        groupCalls.push(id)
        const group = groups.get(id)
        if (!group) throw new Error(`No group with id ${id}`)
        return group
    })
})

afterEach(() => {
    mock.timers.reset()
    mock.restoreAll()
    delete globalThis.chrome
})

test('getTabGroup resolves title and color through chrome.tabGroups', async () => {
    assert.deepEqual(await helpers.getTabGroup(7), {
        title: 'Work',
        color: 'blue',
    })
    assert.deepEqual(groupCalls, [7])
})

test('getTabGroup keeps an empty title for unnamed groups', async () => {
    groups.set(9, { id: 9, title: '', color: 'grey' })
    assert.deepEqual(await helpers.getTabGroup(9), { title: '', color: 'grey' })
})

test('getTabGroup skips the lookup when the tab has no group', async () => {
    assert.equal(await helpers.getTabGroup(undefined), undefined)
    assert.equal(await helpers.getTabGroup(-1), undefined)
    assert.deepEqual(groupCalls, [])
})

test('getTabGroup returns undefined when tabGroups is unavailable', async () => {
    delete globalThis.chrome
    assert.equal(await helpers.getTabGroup(7), undefined)
    globalThis.chrome = {}
    assert.equal(await helpers.getTabGroup(7), undefined)
})

test('getTabGroup treats a rejected lookup as ungrouped', async () => {
    assert.equal(await helpers.getTabGroup(99), undefined)
})

test('grouped tab adds tab_group and tab_group_color to the event', async () => {
    useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [{ ...BASE, ...WORK }])
    assert.deepEqual(groupCalls, [7])
})

test('unnamed group sends an empty tab_group', async () => {
    groups.set(9, { id: 9, title: '', color: 'grey' })
    useTab(makeTab({ groupId: 9 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [
        { ...BASE, tab_group: '', tab_group_color: 'grey' },
    ])
})

test('ungrouped tabs send the unchanged event and skip the lookup', async () => {
    useTab(makeTab({ groupId: -1 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)

    const missingGroupId = makeTab()
    delete missingGroupId.groupId
    useTab(missingGroupId)
    await heartbeat.sendInitialHeartbeat(CLIENT)

    assert.deepEqual(sentData(), [BASE, BASE])
    assert.deepEqual(groupCalls, [])
})

test('browsers without tabGroups send the unchanged event', async () => {
    delete globalThis.chrome
    useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])
})

test('a rejected group lookup falls back to the original event and keeps the queue alive', async () => {
    useTab(makeTab({ groupId: 99 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(sentData(), [BASE])

    const next = useTab(makeTab({ groupId: -1, url: 'https://next.test/' }))
    await heartbeat.tabUpdatedListener(CLIENT)(next.id, { url: next.url }, next)
    assert.deepEqual(sentData().at(-1), { ...BASE, url: 'https://next.test/' })
})

test('moving a tab to another group sends the previous group before the new one', async () => {
    const tab = useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)

    tab.groupId = 8
    await heartbeat.tabUpdatedListener(CLIENT)(tab.id, { groupId: 8 }, tab)

    assert.deepEqual(sentData(), [
        { ...BASE, ...WORK },
        { ...BASE, ...WORK },
        { ...BASE, tab_group: 'Second', tab_group_color: 'red' },
    ])
})

test('removing a tab from its group sends the group event before the ungrouped one', async () => {
    const tab = useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)

    tab.groupId = -1
    await heartbeat.tabUpdatedListener(CLIENT)(tab.id, { groupId: -1 }, tab)

    assert.deepEqual(sentData(), [
        { ...BASE, ...WORK },
        { ...BASE, ...WORK },
        BASE,
    ])
})

test('a group rename is picked up by the heartbeat alarm', async () => {
    useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)

    groups.set(7, { id: 7, title: 'Renamed', color: 'blue' })
    await heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })

    assert.deepEqual(
        sentData().map((data) => data.tab_group),
        ['Work', 'Work', 'Renamed'],
    )
})

test('a tab update that changes only the group triggers a heartbeat', async () => {
    const tab = useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)

    tab.groupId = 8
    await heartbeat.tabUpdatedListener(CLIENT)(tab.id, { groupId: 8 }, tab)
    assert.equal(client.sent.length, 3)
})

test('tab updates without url, title or group changes are ignored', async () => {
    const tab = useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)

    await heartbeat.tabUpdatedListener(CLIENT)(
        tab.id,
        { status: 'complete' },
        tab,
    )
    assert.equal(client.sent.length, 1)
})

test('tab update snapshot keeps only lightweight fields and the group id', async () => {
    let favIconReads = 0
    const tab = useTab(makeTab({ groupId: 7 }))
    Object.defineProperty(tab, 'favIconUrl', {
        enumerable: true,
        get() {
            favIconReads++
            return 'data:image/png;base64,AAAA'
        },
    })

    const pending = heartbeat.tabUpdatedListener(CLIENT)(
        tab.id,
        { url: 'https://example.com/' },
        tab,
    )
    // The event must use values from when it fired, not values read later.
    tab.title = 'Changed after event'
    tab.groupId = 8
    await pending

    assert.equal(favIconReads, 0)
    assert.deepEqual(sentData(), [{ ...BASE, ...WORK }])
})

test('slow group lookups keep overlapping updates in event order', async () => {
    const gate = deferred()
    const log = []
    installChromeTabGroups(async (id) => {
        log.push(`get:${id}`)
        if (id === 7) await gate.promise
        log.push(`resolve:${id}`)
        return groups.get(id)
    })

    const tab = useTab(makeTab({ groupId: 7, url: 'https://a.test/' }))
    const first = heartbeat.tabUpdatedListener(CLIENT)(
        tab.id,
        { url: 'https://a.test/' },
        tab,
    )

    tab.url = 'https://b.test/'
    tab.groupId = 8
    const second = heartbeat.tabUpdatedListener(CLIENT)(
        tab.id,
        { url: 'https://b.test/', groupId: 8 },
        tab,
    )

    // The second lookup must not start until the first queued heartbeat finishes.
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(log, ['get:7'])

    gate.resolve()
    await Promise.all([first, second])

    assert.deepEqual(log, ['get:7', 'resolve:7', 'get:8', 'resolve:8'])
    assert.deepEqual(
        client.sent.map((entry) => [entry.data.url, entry.data.tab_group]),
        [
            ['https://a.test/', 'Work'],
            ['https://a.test/', 'Work'],
            ['https://b.test/', 'Second'],
        ],
    )
    assert.deepEqual(storage.state.heartbeatData, {
        ...BASE,
        url: 'https://b.test/',
        tab_group: 'Second',
        tab_group_color: 'red',
    })
})

// Focus gating must compose with group-only updates and the serialized queue.
test('unfocused opt-in suppresses group updates and activation heartbeats', async () => {
    storage.state.pauseWhenUnfocused = true
    browser.state.focused = false
    await heartbeat.refreshWindowFocus()
    const tab = useTab(makeTab({ groupId: 7 }))

    await heartbeat.tabUpdatedListener(CLIENT)(tab.id, { groupId: 7 }, tab)
    await heartbeat.tabActivatedListener(CLIENT)({ tabId: tab.id })
    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(client.sent, [])
    assert.deepEqual(groupCalls, [])
})

test('pause remains opt-in for group-only updates in an unfocused browser', async () => {
    browser.state.focused = false
    await heartbeat.refreshWindowFocus()
    const tab = useTab(makeTab({ groupId: 7 }))

    await heartbeat.tabUpdatedListener(CLIENT)(tab.id, { groupId: 7 }, tab)
    assert.deepEqual(sentData(), [{ ...BASE, ...WORK }])
})

test('polled focus loss does not extend activity and polled gain starts a fresh event', async () => {
    storage.state.pauseWhenUnfocused = true
    useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)
    browser.state.focused = false

    await heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    assert.equal(client.sent.length, 1)
    assert.equal(storage.state.heartbeatData, undefined)
    await heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    assert.equal(client.sent.length, 1)

    browser.state.focused = true
    await heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    assert.equal(client.sent.length, 2)
    assert.equal(client.sent.at(-1).pulsetime, 0)
    assert.deepEqual(sentData(), [
        { ...BASE, ...WORK },
        { ...BASE, ...WORK },
    ])
})

test('focus events close activity then resume with zero pulsetime', async () => {
    storage.state.pauseWhenUnfocused = true
    useTab(makeTab({ groupId: 7 }))
    await heartbeat.sendInitialHeartbeat(CLIENT)

    await heartbeat.windowFocusChangedListener(CLIENT)(-1)
    assert.equal(client.sent.length, 2)
    assert.equal(client.sent.at(-1).pulsetime, 80)
    assert.equal(storage.state.heartbeatData, undefined)
    await heartbeat.windowFocusChangedListener(CLIENT)(1)
    assert.equal(client.sent.length, 3)
    assert.equal(client.sent.at(-1).pulsetime, 0)
})

for (const event of ['update', 'activation']) {
    test(`queued ${event} received while paused stays suppressed after refocus`, async () => {
        storage.state.pauseWhenUnfocused = true
        const gate = deferred()
        const entered = deferred()
        installChromeTabGroups(async (id) => {
            entered.resolve()
            await gate.promise
            return groups.get(id)
        })
        const tab = useTab(makeTab({ groupId: 7 }))
        const first = heartbeat.sendInitialHeartbeat(CLIENT)
        await entered.promise
        const lost = heartbeat.windowFocusChangedListener(CLIENT)(-1)
        // Let the old implementation enqueue its loss task, isolating the
        // event-time focus bug from the settings/transition ordering bug.
        await new Promise((resolve) => setImmediate(resolve))
        const paused =
            event === 'update'
                ? heartbeat.tabUpdatedListener(CLIENT)(
                      tab.id,
                      { title: tab.title },
                      tab,
                  )
                : heartbeat.tabActivatedListener(CLIENT)({ tabId: tab.id })
        const gained = heartbeat.windowFocusChangedListener(CLIENT)(1)
        gate.resolve()
        await Promise.all([first, lost, paused, gained])
        assert.deepEqual(
            client.sent.map((entry) => entry.pulsetime),
            [80, 80, 0],
        )
    })
}

test('refocus reserves its queue position before a delayed settings read', async () => {
    storage.state.pauseWhenUnfocused = true
    const tab = useTab(makeTab())
    await heartbeat.sendInitialHeartbeat(CLIENT)
    await heartbeat.windowFocusChangedListener(CLIENT)(-1)
    const gate = deferred()
    storage.state.pauseReadGate = gate.promise
    const gained = heartbeat.windowFocusChangedListener(CLIENT)(1)
    const activated = heartbeat.tabActivatedListener(CLIENT)({ tabId: tab.id })
    gate.resolve()
    await Promise.all([gained, activated])
    assert.deepEqual(
        client.sent.map((entry) => entry.pulsetime),
        [80, 80, 0, 80],
    )
})

test('quick loss and gain retain both transition timestamps while settings wait', async () => {
    storage.state.pauseWhenUnfocused = true
    useTab(makeTab())
    await heartbeat.sendInitialHeartbeat(CLIENT)
    const gate = deferred()
    storage.state.pauseReadGate = gate.promise
    mock.timers.enable({ apis: ['Date'], now: 10000 })
    const lost = heartbeat.windowFocusChangedListener(CLIENT)(-1)
    mock.timers.tick(5000)
    const gained = heartbeat.windowFocusChangedListener(CLIENT)(1)
    mock.timers.tick(5000)
    gate.resolve()
    await Promise.all([lost, gained])
    assert.deepEqual(
        client.sent
            .slice(1)
            .map((entry) => [entry.timestamp.getTime(), entry.pulsetime]),
        [
            [10000, 80],
            [15000, 0],
        ],
    )
})

test('polled refocus reserves the resume before activation while settings wait', async () => {
    storage.state.pauseWhenUnfocused = true
    const tab = useTab(makeTab())
    await heartbeat.sendInitialHeartbeat(CLIENT)
    await heartbeat.windowFocusChangedListener(CLIENT)(-1)
    const gate = deferred()
    storage.state.pauseReadGate = gate.promise
    const poll = heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    await new Promise((resolve) => setImmediate(resolve))
    const activated = heartbeat.tabActivatedListener(CLIENT)({ tabId: tab.id })
    gate.resolve()
    await Promise.all([poll, activated])
    assert.deepEqual(
        client.sent.map((entry) => entry.pulsetime),
        [80, 80, 0, 80],
    )
})

test('a stale focus query cannot overwrite a newer loss event', async () => {
    storage.state.pauseWhenUnfocused = true
    const tab = useTab(makeTab())
    await heartbeat.sendInitialHeartbeat(CLIENT)
    const gate = deferred()
    mock.method(browser.default.windows, 'getLastFocused', () => gate.promise)
    const poll = heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    const lost = heartbeat.windowFocusChangedListener(CLIENT)(-1)
    gate.resolve({ focused: true })
    await Promise.all([poll, lost])
    const count = client.sent.length
    await heartbeat.tabUpdatedListener(CLIENT)(
        tab.id,
        { title: tab.title },
        tab,
    )
    assert.equal(client.sent.length, count)
})

for (const pauseWhenUnfocused of [false, true]) {
    test(`stale alarm still reports when switching focused windows (pause=${pauseWhenUnfocused})`, async () => {
        storage.state.pauseWhenUnfocused = pauseWhenUnfocused
        useTab(makeTab())
        await heartbeat.sendInitialHeartbeat(CLIENT)
        const gate = deferred()
        mock.method(
            browser.default.windows,
            'getLastFocused',
            () => gate.promise,
        )
        const poll = heartbeat.heartbeatAlarmListener(CLIENT)({
            name: 'heartbeat',
        })
        await heartbeat.windowFocusChangedListener(CLIENT)(2)
        gate.resolve({ focused: false })
        await poll
        assert.equal(client.sent.length, 2)
        assert.equal(client.sent.at(-1).pulsetime, 80)
    })
}

for (const observation of ['event', 'poll']) {
    for (const missing of ['title', 'tab']) {
        test(`${observation} resume preserves boundary after missing ${missing}`, async () => {
            storage.state.pauseWhenUnfocused = true
            const tab = useTab(makeTab())
            await heartbeat.sendInitialHeartbeat(CLIENT)
            await heartbeat.windowFocusChangedListener(CLIENT)(-1)
            if (missing === 'title') tab.title = ''
            else browser.state.activeTabId = undefined
            if (observation === 'event') {
                await heartbeat.windowFocusChangedListener(CLIENT)(1)
            } else {
                await heartbeat.heartbeatAlarmListener(CLIENT)({
                    name: 'heartbeat',
                })
            }
            assert.equal(client.sent.length, 2)
            tab.title = 'Example'
            browser.state.activeTabId = tab.id
            await heartbeat.tabUpdatedListener(CLIENT)(
                tab.id,
                { title: tab.title },
                tab,
            )
            assert.equal(client.sent.at(-1).pulsetime, 0)
            await heartbeat.tabActivatedListener(CLIENT)({ tabId: tab.id })
            assert.equal(client.sent.at(-1).pulsetime, 80)
        })
    }
}

test('failed resume send preserves boundary until a successful retry', async () => {
    storage.state.pauseWhenUnfocused = true
    useTab(makeTab())
    await heartbeat.sendInitialHeartbeat(CLIENT)
    await heartbeat.windowFocusChangedListener(CLIENT)(-1)
    CLIENT.send = () => {
        throw new Error('offline')
    }
    try {
        await assert.rejects(
            heartbeat.windowFocusChangedListener(CLIENT)(1),
            /offline/,
        )
    } finally {
        delete CLIENT.send
    }
    await heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    assert.equal(client.sent.at(-1).pulsetime, 0)
    await heartbeat.heartbeatAlarmListener(CLIENT)({ name: 'heartbeat' })
    assert.equal(client.sent.at(-1).pulsetime, 80)
})

// Unlike the lightweight client stub, this runs production sendHeartbeat and
// real p-retry so an exhausted retry cannot masquerade as a successful send.
test('production sender retains failed resume boundary through exhausted retries', async () => {
    const real = await loadFixture({ productionClient: true })
    try {
        real.storage.state.pauseWhenUnfocused = true
        real.browser.state.tabs = [makeTab()]
        real.browser.state.activeTabId = 1
        const sent = []
        let offline = false
        let failures = 0
        const aw = {
            ensureBucket: async () => {},
            heartbeat: async (_bucket, pulsetime, event) => {
                if (offline) {
                    failures++
                    throw new Error('offline')
                }
                sent.push({ pulsetime, ...event })
            },
        }
        await real.heartbeat.sendInitialHeartbeat(aw)
        await real.heartbeat.windowFocusChangedListener(aw)(-1)
        offline = true
        await real.heartbeat.windowFocusChangedListener(aw)(1)
        assert.equal(failures, 4)
        offline = false
        await real.heartbeat.heartbeatAlarmListener(aw)({ name: 'heartbeat' })
        assert.equal(sent.at(-1).pulsetime, 0)
        await real.heartbeat.heartbeatAlarmListener(aw)({ name: 'heartbeat' })
        assert.equal(sent.at(-1).pulsetime, 80)
    } finally {
        await real.cleanup()
    }
})

for (const missing of ['title', 'url', 'tab']) {
    test(`focus loss closes last reportable data with missing ${missing}`, async () => {
        storage.state.pauseWhenUnfocused = true
        const tab = useTab(makeTab({ groupId: 7 }))
        await heartbeat.sendInitialHeartbeat(CLIENT)
        if (missing === 'tab') browser.state.activeTabId = undefined
        else tab[missing] = ''
        mock.timers.enable({ apis: ['Date'], now: 30000 })
        await heartbeat.windowFocusChangedListener(CLIENT)(-1)
        assert.equal(client.sent.length, 2)
        assert.deepEqual(client.sent.at(-1).data, { ...BASE, ...WORK })
        assert.equal(client.sent.at(-1).timestamp.getTime(), 30000)
        assert.equal(storage.state.heartbeatData, undefined)
        useTab(makeTab({ groupId: 7 }))
        await heartbeat.windowFocusChangedListener(CLIENT)(1)
        assert.equal(client.sent.at(-1).pulsetime, 0)
    })
}

test('startup missed gain reserves a resume boundary before sending', async () => {
    const startup = await loadFixture()
    const gate = deferred()
    try {
        startup.storage.state.pauseWhenUnfocused = true
        startup.storage.state.enableGate = gate.promise
        startup.browser.state.focused = false
        startup.browser.state.tabs = [makeTab()]
        startup.browser.state.activeTabId = 1
        await startup.start()
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(startup.client.sent.length, 0)
        startup.browser.state.focused = true
        gate.resolve()
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(startup.client.sent.length, 1)
        assert.equal(startup.client.sent[0].pulsetime, 0)
        await startup.heartbeat.heartbeatAlarmListener(CLIENT)({
            name: 'heartbeat',
        })
        assert.equal(startup.client.sent.at(-1).pulsetime, 80)
    } finally {
        gate.resolve()
        await startup.cleanup()
    }
})

test('failed current send does not extend already closed previous activity on retry', async () => {
    const real = await loadFixture({ productionClient: true })
    try {
        const sent = []
        let failB = true
        const aw = {
            ensureBucket: async () => {},
            heartbeat: async (_bucket, pulsetime, event) => {
                if (event.data.title === 'B' && failB)
                    throw new Error('offline B')
                sent.push({ pulsetime, ...event })
            },
        }
        const tab = makeTab({ title: 'A' })
        real.browser.state.tabs = [tab]
        real.browser.state.activeTabId = 1
        mock.timers.enable({ apis: ['Date'], now: 0 })
        await real.heartbeat.sendInitialHeartbeat(aw)
        mock.timers.tick(10000)
        tab.title = 'B'
        await real.heartbeat.tabUpdatedListener(aw)(1, { title: 'B' }, tab)
        mock.timers.tick(10000)
        failB = false
        await real.heartbeat.sendInitialHeartbeat(aw)
        assert.deepEqual(
            sent
                .filter((e) => e.data.title === 'A')
                .map((e) => e.timestamp.getTime()),
            [0, 9999],
        )
        assert.equal(sent.at(-1).data.title, 'B')
    } finally {
        await real.cleanup()
    }
})

test('queued refocus reports its captured tab, not a later unfocused navigation', async () => {
    storage.state.pauseWhenUnfocused = true
    const gate = deferred()
    const entered = deferred()
    installChromeTabGroups(async (id) => {
        entered.resolve()
        await gate.promise
        return groups.get(id)
    })
    const tab = useTab(makeTab({ title: 'A', groupId: 7 }))
    const first = heartbeat.sendInitialHeartbeat(CLIENT)
    await entered.promise
    const loss = heartbeat.windowFocusChangedListener(CLIENT)(-1)
    const gain = heartbeat.windowFocusChangedListener(CLIENT)(1)
    await new Promise((resolve) => setImmediate(resolve))
    const lossAgain = heartbeat.windowFocusChangedListener(CLIENT)(-1)
    tab.title = 'B'
    const update = heartbeat.tabUpdatedListener(CLIENT)(1, { title: 'B' }, tab)
    gate.resolve()
    await Promise.all([first, loss, gain, lossAgain, update])
    assert.deepEqual(
        sentData().map((data) => data.title),
        ['A', 'A', 'A', 'A'],
    )
})

for (const newerFirst of [false, true]) {
    test(`overlapping focus polls use published observations, not cached focus (newer first=${newerFirst})`, async () => {
        storage.state.pauseWhenUnfocused = true
        const tab = useTab(makeTab())
        await heartbeat.sendInitialHeartbeat(CLIENT)
        const firstQuery = deferred()
        const secondQuery = deferred()
        let queries = 0
        mock.method(browser.default.windows, 'getLastFocused', () =>
            ++queries === 1 ? firstQuery.promise : secondQuery.promise,
        )
        const first = heartbeat.refreshAndSendHeartbeat(CLIENT)
        const second = heartbeat.refreshAndSendHeartbeat(CLIENT)
        try {
            if (newerFirst) {
                secondQuery.resolve({ focused: false })
                await second
                // An older focused result must not undo the newer loss.
                firstQuery.resolve({ focused: true })
            } else {
                firstQuery.resolve({ focused: false })
                await first
                // A newer outstanding query is not a published observation.
                assert.equal(client.sent.length, 1)
                secondQuery.resolve({ focused: false })
            }
            await Promise.all([first, second])
            await heartbeat.tabUpdatedListener(CLIENT)(
                1,
                { title: tab.title },
                tab,
            )
            assert.equal(client.sent.length, 1)
            assert.equal(storage.state.heartbeatData, undefined)
        } finally {
            firstQuery.resolve({ focused: false })
            secondQuery.resolve({ focused: false })
            await Promise.all([first, second])
        }
    })
}

test('queued polled refocus freezes tab data before earlier sends drain', async () => {
    storage.state.pauseWhenUnfocused = true
    const gate = deferred()
    const entered = deferred()
    installChromeTabGroups(async (id) => {
        entered.resolve()
        await gate.promise
        return groups.get(id)
    })
    const tab = useTab(makeTab({ title: 'A', groupId: 7 }))
    const first = heartbeat.sendInitialHeartbeat(CLIENT)
    await entered.promise
    const loss = heartbeat.windowFocusChangedListener(CLIENT)(-1)
    // No focus-gain event: the poll is the only observer of refocus.
    const gain = heartbeat.refreshAndSendHeartbeat(CLIENT)
    await new Promise((resolve) => setImmediate(resolve))
    const lossAgain = heartbeat.windowFocusChangedListener(CLIENT)(-1)
    tab.title = 'B'
    const update = heartbeat.tabUpdatedListener(CLIENT)(1, { title: 'B' }, tab)
    gate.resolve()
    await Promise.all([first, loss, gain, lossAgain, update])
    assert.deepEqual(
        sentData().map((data) => data.title),
        ['A', 'A', 'A', 'A'],
    )
    assert.deepEqual(
        client.sent.map((entry) => entry.pulsetime),
        [80, 80, 0, 80],
    )
})

// A failed intermediate page must not let a later return bridge its interval.
test('failed page change retains a fresh boundary when returning to the previous page', async () => {
    const real = await loadFixture({ productionClient: true })
    try {
        const sent = []
        const aw = {
            ensureBucket: async () => {},
            heartbeat: async (_bucket, pulsetime, event) => {
                if (event.data.title === 'B') throw new Error('offline B')
                sent.push({ pulsetime, ...event })
            },
        }
        const tab = makeTab({ title: 'A' })
        real.browser.state.tabs = [tab]
        real.browser.state.activeTabId = 1
        mock.timers.enable({ apis: ['Date'], now: 0 })
        await real.heartbeat.sendInitialHeartbeat(aw)
        mock.timers.tick(10000)
        tab.title = 'B'
        await real.heartbeat.tabUpdatedListener(aw)(1, { title: 'B' }, tab)
        mock.timers.tick(10000)
        tab.title = 'A'
        await real.heartbeat.tabUpdatedListener(aw)(1, { title: 'A' }, tab)
        assert.equal(sent.at(-1).timestamp.getTime(), 20000)
        assert.equal(sent.at(-1).pulsetime, 0)
        await real.heartbeat.sendInitialHeartbeat(aw)
        assert.equal(sent.at(-1).pulsetime, 80)
    } finally {
        await real.cleanup()
    }
})

test('queued activation freezes its tab before later unfocused navigation', async () => {
    storage.state.pauseWhenUnfocused = true
    const gate = deferred()
    const entered = deferred()
    installChromeTabGroups(async (id) => {
        entered.resolve()
        await gate.promise
        return groups.get(id)
    })
    const tab = useTab(makeTab({ title: 'A', groupId: 7 }))
    const first = heartbeat.sendInitialHeartbeat(CLIENT)
    await entered.promise
    const activated = heartbeat.tabActivatedListener(CLIENT)({ tabId: 1 })
    await new Promise((resolve) => setImmediate(resolve))
    const lost = heartbeat.windowFocusChangedListener(CLIENT)(-1)
    tab.title = 'B'
    const updated = heartbeat.tabUpdatedListener(CLIENT)(1, { title: 'B' }, tab)
    gate.resolve()
    await Promise.all([first, activated, lost, updated])
    assert.deepEqual(
        sentData().map((data) => data.title),
        ['A', 'A', 'A'],
    )
})

// Reload only the background module; browser.storage survives as it does when
// saving extension settings. Both storage and the retrying sender are production.
for (const transition of ['page', 'event loss', 'polled loss']) {
    test(`background restart retains the ${transition} boundary`, async () => {
        const real = await loadFixture({
            productionClient: true,
            productionStorage: true,
        })
        try {
            await real.storage.setEnabled(true)
            await real.storage.setPauseWhenUnfocused(transition !== 'page')
            const tab = makeTab({ title: 'A' })
            real.browser.state.tabs = [tab]
            real.browser.state.activeTabId = 1
            const sent = []
            let failures = 0
            const aw = {
                ensureBucket: async () => {},
                heartbeat: async (_bucket, pulsetime, event) => {
                    if (event.data.title === 'B') {
                        failures++
                        throw new Error('offline B')
                    }
                    sent.push({ pulsetime, ...event })
                },
            }
            mock.timers.enable({ apis: ['Date'], now: 0 })
            await real.heartbeat.sendInitialHeartbeat(aw)
            mock.timers.tick(10000)
            if (transition === 'page') {
                tab.title = 'B'
                await real.heartbeat.tabUpdatedListener(aw)(
                    1,
                    { title: 'B' },
                    tab,
                )
                assert.equal(failures, 4)
            } else if (transition === 'event loss') {
                await real.heartbeat.windowFocusChangedListener(aw)(-1)
            } else {
                real.browser.state.focused = false
                await real.heartbeat.refreshAndSendHeartbeat(aw)
            }
            assert.equal(await real.storage.getHeartbeatData(), undefined)
            const restarted = await real.restartHeartbeat()
            mock.timers.tick(10000)
            tab.title = 'A'
            real.browser.state.focused = true
            await restarted.refreshAndSendHeartbeat(aw)
            assert.equal(sent.at(-1).timestamp.getTime(), 20000)
            assert.equal(sent.at(-1).pulsetime, 0)
            // A second reload must see a confirmed send, not a stale marker.
            const confirmed = await real.restartHeartbeat()
            await confirmed.sendInitialHeartbeat(aw)
            assert.equal(sent.at(-1).pulsetime, 80)
        } finally {
            await real.cleanup()
        }
    })
}

for (const transition of ['page', 'event loss']) {
    test(`restart during ${transition} closing request retains a boundary`, async () => {
        const real = await loadFixture({
            productionClient: true,
            productionStorage: true,
        })
        const gate = deferred()
        const entered = deferred()
        let closing
        try {
            await real.storage.setEnabled(true)
            await real.storage.setPauseWhenUnfocused(
                transition === 'event loss',
            )
            const tab = makeTab({ title: 'A' })
            real.browser.state.tabs = [tab]
            real.browser.state.activeTabId = 1
            const sent = []
            let block = false
            const aw = {
                ensureBucket: async () => {},
                heartbeat: async (_bucket, pulsetime, event) => {
                    if (block) {
                        entered.resolve()
                        await gate.promise
                    }
                    sent.push({ pulsetime, ...event })
                },
            }
            await real.heartbeat.sendInitialHeartbeat(aw)
            block = true
            if (transition === 'page') {
                tab.title = 'B'
                closing = real.heartbeat.tabUpdatedListener(aw)(
                    1,
                    { title: 'B' },
                    tab,
                )
            } else closing = real.heartbeat.windowFocusChangedListener(aw)(-1)
            await entered.promise
            const restarted = await real.restartHeartbeat()
            tab.title = 'A'
            block = false
            await restarted.sendInitialHeartbeat(aw)
            assert.equal(sent.at(-1).pulsetime, 0)
        } finally {
            gate.resolve()
            await closing
            await real.cleanup()
        }
    })
}

test('startup unfocused observation persists a boundary even if focus was already refreshed', async () => {
    const real = await loadFixture({ productionStorage: true })
    try {
        await real.storage.setEnabled(true)
        await real.storage.setPauseWhenUnfocused(true)
        real.browser.state.tabs = [makeTab()]
        real.browser.state.activeTabId = 1
        await real.heartbeat.sendInitialHeartbeat(CLIENT)
        real.browser.state.focused = false
        await real.heartbeat.refreshWindowFocus()
        await real.heartbeat.refreshAndSendHeartbeat(CLIENT)
        const restarted = await real.restartHeartbeat()
        real.browser.state.focused = true
        await restarted.refreshAndSendHeartbeat(CLIENT)
        assert.equal(real.client.sent.at(-1).pulsetime, 0)
    } finally {
        await real.cleanup()
    }
})
