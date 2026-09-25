import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { event, flush, loadModule } from './load-module.mjs'

function chromiumPage({
    url = 'https://example.com/',
    title = 'Report - example.com/',
} = {}) {
    const attributes = new Map()
    const document = {
        title,
        head: {},
        documentElement: {
            getAttribute: (key) => attributes.get(key) ?? null,
            setAttribute: (key, value) => attributes.set(key, value),
            removeAttribute: (key) => attributes.delete(key),
        },
    }
    const location = new URL(url)
    let rejectInjection = false
    const chrome = {
        runtime: { id: 'test-extension' },
        scripting: {
            registerContentScripts() {},
            executeScript: async ({ func, args, target }) => {
                assert.equal(target.tabId, 7)
                if (rejectInjection) throw Error('Cannot access this page')
                // Serialization catches accidental closure references in injected code.
                const result = vm.runInNewContext(
                    `(${func.toString()})(...args)`,
                    {
                        location,
                        document,
                        args,
                    },
                )
                return [{ result }]
            },
        },
    }
    const module = loadModule(
        'src/background/hostnameInTitle.ts',
        {
            'webextension-polyfill': {},
            '../storage': {
                getHostnameInTitle: async () => true,
                getHostnameInTitleApplied: async () => false,
            },
        },
        { chrome },
    )
    return {
        document,
        location,
        rejectInjection: () => {
            rejectInjection = true
        },
        original: (snapshot = document.title) =>
            module.originalTitle(7, url, snapshot),
        inject: () =>
            loadModule(
                'src/content/hostnameInTitle.ts',
                {},
                {
                    chrome,
                    document,
                    location,
                    MutationObserver: class {
                        observe() {}
                        disconnect() {}
                    },
                },
            ),
    }
}

test('a natural hostname suffix survives before and after content-script injection', async () => {
    const page = chromiumPage()
    const original = page.document.title
    assert.equal(await page.original(), original)
    page.inject()
    assert.equal(page.document.title, 'Report - example.com/ - example.com/')
    assert.equal(await page.original(), original)
    // An event captured before injection must not be stripped afterwards either.
    assert.equal(await page.original(original), original)
})

test('page additions around an extension-written title retain their own suffix-like text', async () => {
    const page = chromiumPage()
    page.inject()
    page.document.title = `(1) ${page.document.title} updated`
    assert.equal(await page.original(), '(1) Report - example.com/ updated')
})

test('restricted pages preserve natural hostname-like titles', async () => {
    const page = chromiumPage()
    page.rejectInjection()
    assert.equal(await page.original(), 'Report - example.com/')
})

test('a response from a navigated document does not rewrite the old event', async () => {
    const page = chromiumPage()
    page.inject()
    page.location.href = 'https://example.com/new-document'
    assert.equal(await page.original(), page.document.title)
})

test('loopback ports are removed only when the document marker confirms the write', async () => {
    const page = chromiumPage({
        url: 'http://localhost:3000/',
        title: 'Project - localhost:3000/',
    })
    assert.equal(await page.original(), 'Project - localhost:3000/')
    page.inject()
    assert.equal(await page.original(), 'Project - localhost:3000/')
})

async function firefox({
    enabled = false,
    owned = {},
    windowTitle = 'Other extension - Page',
} = {}) {
    const updates = []
    let onSettingChanged
    let persisted = structuredClone(owned)
    const browser = {
        windows: {
            getAll: async () => [{ id: 1 }],
            get: async () => ({ id: 1, title: windowTitle }),
            update: async (_id, update) => {
                updates.push(update.titlePreface)
                windowTitle = `${update.titlePreface}Page`
            },
            onRemoved: event(),
        },
        tabs: {
            query: async () => [
                { active: true, url: 'https://example.com/', incognito: false },
            ],
            onActivated: event(),
            onUpdated: event(),
        },
    }
    const module = loadModule(
        'src/background/hostnameInTitle.ts',
        {
            'webextension-polyfill': browser,
            '../storage': {
                getHostnameInTitle: async () => enabled,
                watchHostnameInTitle: (listener) => {
                    onSettingChanged = listener
                },
                getFirefoxTitlePrefaces: async () => structuredClone(persisted),
                setFirefoxTitlePrefaces: async (value) => {
                    persisted = structuredClone(value)
                },
            },
        },
        { __env: { VITE_TARGET_BROWSER: 'firefox' } },
    )
    module.setupHostnameInTitle()
    await flush()
    return {
        updates,
        browser,
        owned: () => persisted,
        changeTitle: (title) => {
            windowTitle = title
        },
        toggle: async (value) => {
            onSettingChanged(value)
            await flush()
        },
    }
}

test('Firefox with the feature disabled leaves other window prefixes alone', async () => {
    const state = await firefox()
    assert.deepEqual(state.updates, [])
})

test('Firefox removes its own prefix when disabled, including after a reload', async () => {
    const state = await firefox({ enabled: true })
    assert.deepEqual(state.updates, ['example.com/ - '])
    assert.equal(state.owned()[1], 'example.com/ - ')
    await state.toggle(false)
    assert.deepEqual(state.updates, ['example.com/ - ', ''])
    assert.deepEqual(state.owned(), {})
    const reloaded = await firefox({
        owned: { 1: 'example.com/ - ' },
        windowTitle: 'example.com/ - Page',
    })
    assert.deepEqual(reloaded.updates, [''])
    assert.deepEqual(reloaded.owned(), {})
})

test('Firefox cleanup preserves a replacement prefix from another extension', async () => {
    const state = await firefox({ enabled: true })
    state.changeTitle('Other extension - Page')
    await state.toggle(false)
    assert.deepEqual(state.updates, ['example.com/ - '])
    assert.deepEqual(state.owned(), {})
})

test('Firefox forgets ownership of closed windows', async () => {
    const state = await firefox({ enabled: true })
    await state.browser.windows.onRemoved.emit(1)
    await flush()
    assert.deepEqual(state.owned(), {})
})
