import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { event, flush, loadModule } from './load-module.mjs'

function chromiumPage({
    url = 'https://example.com/',
    title = 'Report - example.com/',
    domainOnly = true,
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
    const settings = { urlInTitleDomainOnly: domainOnly }
    const storageChanged = event()
    const navigation = event()
    const messages = event()
    // When set, storage reads wait until the test resolves them.
    let pendingReads = null
    const chrome = {
        runtime: {
            id: 'test-extension',
            onMessage: {
                addListener: messages.addListener,
                removeListener() {},
            },
        },
        storage: {
            local: {
                get: (key) => {
                    const value = { [key]: settings[key] }
                    if (!pendingReads) return Promise.resolve(value)
                    return new Promise((resolve) =>
                        pendingReads.push(() => resolve(value)),
                    )
                },
            },
            onChanged: {
                addListener: storageChanged.addListener,
                removeListener() {},
            },
        },
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
        'src/background/urlInTitle.ts',
        {
            'webextension-polyfill': {},
            '../storage': {
                getUrlInTitle: async () => true,
                getUrlInTitleApplied: async () => false,
            },
        },
        { chrome },
    )
    const page = {
        document,
        location,
        rejectInjection: () => {
            rejectInjection = true
        },
        // Heartbeats pass the tab URL they captured with the title.
        original: (snapshot = document.title, tabUrl = url) =>
            module.originalTitle(7, tabUrl, snapshot),
        // The content script reads its mode from storage before writing.
        inject: async () => {
            loadModule(
                'src/content/urlInTitle.ts',
                {},
                {
                    chrome,
                    document,
                    location,
                    navigation: {
                        addEventListener: (_type, listener) =>
                            navigation.addListener(listener),
                        removeEventListener() {},
                    },
                    MutationObserver: class {
                        observe() {}
                        disconnect() {}
                    },
                },
                (context) => {
                    page.context = context
                },
            )
            await flush()
        },
        controller: () => page.context.__awUrlInTitle,
        holdReads: () => {
            pendingReads = []
            return pendingReads
        },
        message: async (message) => {
            await messages.emit(message)
        },
        navigate: async (href) => {
            location.href = href
            await navigation.emit()
        },
        setDomainOnly: async (value) => {
            settings.urlInTitleDomainOnly = value
            await storageChanged.emit(
                { urlInTitleDomainOnly: { newValue: value } },
                'local',
            )
            await flush()
        },
    }
    return page
}

test('a natural hostname suffix survives before and after content-script injection', async () => {
    const page = chromiumPage()
    const original = page.document.title
    assert.equal(await page.original(), original)
    await page.inject()
    assert.equal(page.document.title, 'Report - example.com/ - example.com/')
    assert.equal(await page.original(), original)
    // A stale pre-injection event is skipped if its marker is no longer current.
    assert.equal(await page.original(original), undefined)
})

test('page additions around an extension-written title retain their own suffix-like text', async () => {
    const page = chromiumPage()
    await page.inject()
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
    await page.inject()
    page.location.href = 'https://example.com/new-document'
    assert.equal(await page.original(), undefined)
})

test('a replaced title marker makes the previous snapshot stale', async () => {
    const page = chromiumPage()
    page.inject()
    const oldTitle = page.document.title
    page.document.title = 'New title - example.com/'
    page.document.documentElement.setAttribute(
        'data-aw-watcher-web-title',
        JSON.stringify({
            title: page.document.title,
            suffix: ' - example.com/',
        }),
    )
    assert.equal(await page.original(oldTitle), undefined)
    assert.equal(await page.original(), 'New title')
})

test('loopback ports are removed only when the document marker confirms the write', async () => {
    const page = chromiumPage({
        url: 'http://localhost:3000/',
        title: 'Project - localhost:3000/',
    })
    assert.equal(await page.original(), 'Project - localhost:3000/')
    await page.inject()
    assert.equal(await page.original(), 'Project - localhost:3000/')
})

async function firefox({
    enabled = false,
    domainOnly = true,
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
        'src/background/urlInTitle.ts',
        {
            'webextension-polyfill': browser,
            '../storage': {
                getUrlInTitle: async () => enabled,
                getUrlInTitleDomainOnly: async () => domainOnly,
                watchUrlInTitle: (listener) => {
                    onSettingChanged = listener
                },
                watchUrlInTitleDomainOnly: () => {},
                getFirefoxTitlePrefaces: async () => structuredClone(persisted),
                setFirefoxTitlePrefaces: async (value) => {
                    persisted = structuredClone(value)
                },
            },
        },
        { __env: { VITE_TARGET_BROWSER: 'firefox' } },
    )
    module.setupUrlInTitle()
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

test('full-URL mode appends the whole URL and recovers the page title', async () => {
    const page = chromiumPage({
        url: 'https://example.com/docs?q=1#intro',
        title: 'Docs',
        domainOnly: false,
    })
    await page.inject()
    assert.equal(
        page.document.title,
        'Docs - https://example.com/docs?q=1#intro',
    )
    assert.equal(await page.original(), 'Docs')
})

test('full-URL mode follows in-page navigation without a title change', async () => {
    const page = chromiumPage({ title: 'App', domainOnly: false })
    await page.inject()
    assert.equal(page.document.title, 'App - https://example.com/')
    await page.navigate('https://example.com/settings')
    assert.equal(page.document.title, 'App - https://example.com/settings')
    assert.equal(
        await page.original(page.document.title, page.location.href),
        'App',
    )
})

test('switching to domain only rewrites the suffix in place', async () => {
    const page = chromiumPage({
        url: 'https://example.com/a/b',
        title: 'Page',
        domainOnly: false,
    })
    await page.inject()
    assert.equal(page.document.title, 'Page - https://example.com/a/b')
    await page.setDomainOnly(true)
    assert.equal(page.document.title, 'Page - example.com/')
    await page.setDomainOnly(false)
    assert.equal(page.document.title, 'Page - https://example.com/a/b')
    assert.equal(await page.original(), 'Page')
})

test('Firefox prepends the full URL unless domain only is set', async () => {
    const state = await firefox({ enabled: true, domainOnly: false })
    assert.deepEqual(state.updates, ['https://example.com/ - '])
    assert.equal(state.owned()[1], 'https://example.com/ - ')
})

test('a title captured before a pushState rewrite is dropped, not recorded with the URL', async () => {
    const page = chromiumPage({ title: 'App', domainOnly: false })
    await page.inject()
    const stale = page.document.title
    await page.navigate('https://example.com/next')
    assert.notEqual(page.document.title, stale)
    // The heartbeat snapshot has the old suffix but the tab's new URL.
    assert.equal(await page.original(stale, page.location.href), undefined)
    // The title update that follows the rewrite resolves normally.
    assert.equal(
        await page.original(page.document.title, page.location.href),
        'App',
    )
})

test('a storage read that finishes after stop() does not write the URL back', async () => {
    const page = chromiumPage({ title: 'Page', domainOnly: false })
    const reads = page.holdReads()
    await page.inject()
    assert.equal(page.document.title, 'Page')
    page.controller().stop()
    reads.forEach((resolve) => resolve())
    await flush()
    assert.equal(page.document.title, 'Page')
})

test('only the newest mode read applies when reads overlap', async () => {
    const page = chromiumPage({ title: 'Page', domainOnly: false })
    await page.inject()
    const reads = page.holdReads()
    await page.setDomainOnly(true)
    await page.setDomainOnly(false)
    // The newer read (full URL) finishes first, then the older one.
    reads[1]()
    await flush()
    reads[0]()
    await flush()
    assert.equal(page.document.title, 'Page - https://example.com/')
})

test('a relayed URL change updates the title without any DOM event', async () => {
    const page = chromiumPage({ title: 'App', domainOnly: false })
    await page.inject()
    // pushState/replaceState without the Navigation API fires nothing.
    page.location.href = 'https://example.com/replaced'
    assert.equal(page.document.title, 'App - https://example.com/')
    await page.message({ type: 'aw-watcher-web:url-in-title:url-changed' })
    assert.equal(page.document.title, 'App - https://example.com/replaced')
})

async function chromiumBackground({ enabled }) {
    const sentMessages = []
    const onUpdated = event()
    let onEnabledChanged
    const browser = {
        tabs: {
            onUpdated,
            query: async () => [],
            sendMessage: async (tabId, message) => {
                sentMessages.push({ tabId, message })
            },
        },
    }
    const chrome = {
        scripting: {
            registerContentScripts: async () => {},
            unregisterContentScripts: async () => {},
            getRegisteredContentScripts: async () => [],
            executeScript: async () => [],
        },
    }
    const module = loadModule(
        'src/background/urlInTitle.ts',
        {
            'webextension-polyfill': browser,
            '../storage': {
                getUrlInTitle: async () => enabled,
                getUrlInTitleDomainOnly: async () => false,
                getUrlInTitleApplied: async () => false,
                setUrlInTitleApplied: async () => {},
                watchUrlInTitle: (listener) => {
                    onEnabledChanged = listener
                },
                watchUrlInTitleDomainOnly: () => {},
            },
        },
        { chrome },
    )
    module.setupUrlInTitle()
    await flush()
    return {
        sentMessages,
        update: (tabId, changeInfo) => onUpdated.emit(tabId, changeInfo, {}),
        toggle: async (value) => {
            onEnabledChanged(value)
            await flush()
        },
    }
}

test('the background relays browser URL changes to the tab while enabled', async () => {
    const background = await chromiumBackground({ enabled: true })
    await background.update(5, { url: 'https://example.com/replaced' })
    await background.update(5, { title: 'Only the title changed' })
    // Messages are built inside the module's own context, so compare values.
    assert.deepEqual(JSON.parse(JSON.stringify(background.sentMessages)), [
        {
            tabId: 5,
            message: { type: 'aw-watcher-web:url-in-title:url-changed' },
        },
    ])
    await background.toggle(false)
    await background.update(5, { url: 'https://example.com/later' })
    assert.equal(background.sentMessages.length, 1)
})
