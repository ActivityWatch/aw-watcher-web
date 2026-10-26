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
export const state = { tabs: [], activeTabId: undefined, focused: true }
const browser = {
  windows: {
    WINDOW_ID_NONE: -1,
    getLastFocused: async () => ({ focused: state.focused }),
  },
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
  },
  runtime: { getURL: (path) => path },
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
export const getEnabled = async () => state.enabled
export const getPauseWhenUnfocused = async () => state.pauseWhenUnfocused
export const clearHeartbeatData = async () => { state.heartbeatData = undefined }
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

// Production import specifier -> specifier to use in the transpiled fixture.
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
    const dir = await mkdtemp(join(tmpdir(), 'aw-tab-groups-'))
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
        profile: undefined,
        heartbeatData: undefined,
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
