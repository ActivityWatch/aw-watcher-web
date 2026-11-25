// Regression tests for sendHeartbeat when browser.notifications is absent
// (e.g. Safari web extensions, where MDN browser-compat-data lists
// notifications as unsupported). The real src/background/client.ts and
// src/background/helpers.ts are transpiled with TypeScript into a temporary
// directory and run unmodified; only webextension-polyfill, storage, config,
// aw-client and p-retry are replaced with in-memory stubs.
//
// Run with: node --test tests/notifications-missing.test.mjs
import { after, afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const SRC_DIR = fileURLToPath(new URL('../src/background/', import.meta.url))

// No `notifications` key by default: this mirrors a browser that does not
// implement the API. webextension-polyfill passes a native `browser` global
// through unchanged, so nothing would fill it in.
const STUB_BROWSER = `
const browser = {
  runtime: { getURL: (path) => path },
}
export default browser
`

const STUB_STORAGE = `
export const state = {
  hostname: 'host',
  syncStatus: { success: undefined },
  syncWrites: [],
  browserName: 'safari',
  browserNameUserSelected: false,
}
export const getApiKey = async () => undefined
export const getHostname = async () => state.hostname
export const getSyncStatus = async () => ({ ...state.syncStatus })
export const setSyncStatus = (success) => {
  state.syncWrites.push(success)
  state.syncStatus = { success, date: new Date().toISOString() }
  return Promise.resolve()
}
export const getBrowserName = async () => state.browserName
export const getBrowserNameUserSelected = async () => state.browserNameUserSelected
export const setBrowserName = async (name) => {
  state.browserName = name
}
`

const STUB_CONFIG = `
export default { isDevelopment: false, heartbeat: { alarmName: 'heartbeat', intervalInSeconds: 60 } }
`

const STUB_AW_CLIENT = `
export class FetchError extends Error {}
export class AWClient {}
`

// Same attempt/onFailedAttempt semantics as p-retry, without backoff delays.
const STUB_P_RETRY = `
export default async function retry(fn, opts = {}) {
  const retries = opts.retries ?? 10
  let lastError
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      return await fn(attempt)
    } catch (error) {
      lastError = error
      error.attemptNumber = attempt
      error.retriesLeft = retries + 1 - attempt
      if (opts.onFailedAttempt) await opts.onFailedAttempt(error)
    }
  }
  throw lastError
}
`

const MODULE_MAP = {
    'webextension-polyfill': './stub-browser.mjs',
    'aw-client': './stub-aw-client.mjs',
    'p-retry': './stub-p-retry.mjs',
    '../config': './stub-config.mjs',
    '../storage': './stub-storage.mjs',
    './browserFork': './browserFork.mjs',
    './helpers': './helpers.mjs',
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
    const dir = await mkdtemp(join(tmpdir(), 'aw-notifications-'))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
        const stubs = {
            'stub-browser.mjs': STUB_BROWSER,
            'stub-storage.mjs': STUB_STORAGE,
            'stub-config.mjs': STUB_CONFIG,
            'stub-aw-client.mjs': STUB_AW_CLIENT,
            'stub-p-retry.mjs': STUB_P_RETRY,
        }
        for (const [name, source] of Object.entries(stubs)) {
            await writeFile(join(dir, name), source)
        }
        for (const name of ['browserFork', 'helpers', 'client']) {
            const source = await readFile(join(SRC_DIR, `${name}.ts`), 'utf8')
            const js = rewriteImports(transpile(source, `${name}.ts`))
            await writeFile(join(dir, `${name}.mjs`), js)
        }
        const load = (name) => import(pathToFileURL(join(dir, name)).href)
        return {
            cleanup,
            client: await load('client.mjs'),
            browser: (await load('stub-browser.mjs')).default,
            storage: await load('stub-storage.mjs'),
        }
    } catch (error) {
        await cleanup()
        throw error
    }
}

const fixture = await loadFixture()
const { client, browser, storage } = fixture
after(() => fixture.cleanup())

const okClient = () => ({
    heartbeat: async () => {},
    ensureBucket: async () => {},
})
const failingClient = () => ({
    heartbeat: async () => {
        throw new Error('connection refused')
    },
    ensureBucket: async () => {
        throw new Error('connection refused')
    },
})

function send(awClient) {
    return client.sendHeartbeat(
        awClient,
        'aw-watcher-web-safari_host',
        new Date(),
        { url: 'https://example.com/', title: 'Example' },
        80,
    )
}

let created

beforeEach(() => {
    mock.method(console, 'debug', () => {})
    mock.method(console, 'warn', () => {})
    mock.method(console, 'error', () => {})
    storage.state.syncWrites = []
    created = []
    delete browser.notifications
})

afterEach(() => {
    mock.restoreAll()
    delete browser.notifications
})

// Controls: with the API present, both paths behave as intended.

test('control: reconnect with notifications available marks sync as success', async () => {
    browser.notifications = { create: (opts) => created.push(opts) }
    storage.state.syncStatus = { success: false }
    await send(okClient())
    assert.deepEqual(
        created.map(({ title }) => title),
        ['Now connected again'],
    )
    assert.deepEqual(storage.state.syncWrites, [true])
})

test('control: first failure with notifications available resolves', async () => {
    browser.notifications = { create: (opts) => created.push(opts) }
    storage.state.syncStatus = { success: true }
    await assert.doesNotReject(send(failingClient()))
    assert.deepEqual(storage.state.syncWrites, [false])
    assert.deepEqual(
        created.map(({ title }) => title),
        ['Unable to send event to server'],
    )
})

// Defect: browser.notifications undefined.

test('without notifications API: successful heartbeat after a failure marks sync as success', async () => {
    storage.state.syncStatus = { success: false }
    await send(okClient())
    assert.equal(storage.state.syncStatus.success, true)
})

test('without notifications API: failed heartbeat after a success still resolves', async () => {
    storage.state.syncStatus = { success: true }
    await assert.doesNotReject(send(failingClient()))
    assert.equal(storage.state.syncStatus.success, false)
})
