// Execute the production popup and bucket writer with browser/DOM boundaries stubbed.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function fixture({
    hostname = 'laptop',
    apiKey = 'test-key',
    fetch,
    stall = false,
    unconfigured = false,
} = {}) {
    const elements = new Map()
    class Element {
        style = { setProperty() {}, removeProperty() {} }
        addEventListener() {}
        removeAttribute() {}
        setAttribute() {}
        querySelector() {
            return new Element()
        }
    }
    const document = {
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element())
            return elements.get(id)
        },
    }
    const storage = {
        getHostname: async () => (unconfigured ? undefined : hostname),
        getBrowserName: async () => 'chrome',
        getProfileName: async () => undefined,
        getApiKey: async () => (unconfigured ? undefined : apiKey),
        getBaseUrl: async () => 'http://localhost:5600',
        getInstallDate: async () => new Date(),
        getEnabled: async () => true,
        getSyncStatus: async () => ({}),
        getConsentStatus: async () => ({}),
        watchSyncDate() {},
        watchSyncSuccess() {},
    }
    let timer
    let cleared = false
    let signal
    const requests = []
    const context = vm.createContext({
        console,
        document,
        HTMLElement: Element,
        HTMLInputElement: Element,
        HTMLButtonElement: Element,
        HTMLAnchorElement: Element,
        AbortController,
        setTimeout(fn) {
            timer = fn
            return 1
        },
        clearTimeout() {
            cleared = true
            timer = undefined
        },
        fetch: async (url, options) => {
            signal = options.signal
            requests.push({ url: new URL(url), options })
            if (fetch) return fetch(url, options)
            return {
                ok: true,
                json: () =>
                    stall
                        ? new Promise((_, reject) =>
                              signal.addEventListener('abort', () =>
                                  reject(new Error('aborted')),
                              ),
                          )
                        : Promise.resolve([{ duration: 144000 }]),
            }
        },
    })
    function load(path, dependencies) {
        const source = readFileSync(new URL(path, import.meta.url), 'utf8')
        const js = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
            },
        }).outputText
        const exports = {}
        const run = vm.runInContext(
            `(function(require, exports) { ${js}\nreturn typeof resolveNudgeTrigger === 'function' ? { resolveNudgeTrigger } : exports })`,
            context,
        )
        return run((name) => {
            assert.ok(name in dependencies, `Unmapped dependency: ${name}`)
            return dependencies[name]
        }, exports)
    }
    const client = load('../src/background/client.ts', {
        '../config': { default: {} },
        'aw-client': {},
        'p-retry': {},
        './helpers': { getBrowser: async () => 'chrome' },
        '../storage': storage,
    })
    const popup = load('../src/popup/main.ts', {
        'webextension-polyfill': {
            default: { storage: { local: { get: async () => ({}) } } },
        },
        '../config': { default: {} },
        '../storage': storage,
        '../background/client': client,
    })
    // Let popup startup finish before inspecting the explicit test invocation.
    return {
        popup,
        requests,
        ready: async () => {
            for (let i = 0; i < 30; i++) await Promise.resolve()
        },
        expire: () => {
            assert.ok(timer, 'timeout must cover the response body')
            timer()
        },
        isCleared: () => cleared,
    }
}

test('reads the writer bucket and authenticates using the configured key', async () => {
    const f = fixture()
    await f.ready()
    assert.equal(await f.popup.resolveNudgeTrigger(), 'inapp-first-week')
    assert.equal(
        f.requests.at(-1).url.pathname,
        '/api/0/buckets/aw-watcher-web-chrome_laptop/events',
    )
    assert.equal(
        f.requests.at(-1).options.headers.Authorization,
        'Bearer test-key',
    )
    assert.equal(f.isCleared(), true)
})

test('uses the writer fallback bucket when hostname is absent, without an empty bearer token', async () => {
    const f = fixture({ unconfigured: true })
    await f.ready()
    assert.equal(await f.popup.resolveNudgeTrigger(), 'inapp-first-week')
    assert.equal(
        f.requests.at(-1).url.pathname,
        '/api/0/buckets/aw-watcher-web-chrome/events',
    )
    assert.equal(f.requests.at(-1).options.headers.Authorization, undefined)
})

test('keeps the timeout active until a stalled response body aborts', async () => {
    const f = fixture({ stall: true })
    await f.ready()
    f.expire()
    await f.ready()
    assert.equal(f.isCleared(), true)
    const pending = f.popup.resolveNudgeTrigger()
    await f.ready()
    f.expire()
    assert.equal(await pending, 'inapp-tenure')
})

test('falls back to tenure on HTTP and JSON failures', async () => {
    for (const response of [
        { ok: false },
        {
            ok: true,
            json: async () => {
                throw new Error('invalid JSON')
            },
        },
        { ok: true, json: async () => [{ duration: 3600 }] },
    ]) {
        const f = fixture({ fetch: async () => response })
        await f.ready()
        assert.equal(await f.popup.resolveNudgeTrigger(), 'inapp-tenure')
        assert.equal(f.isCleared(), true)
    }
})
