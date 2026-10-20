// Execute actual TypeScript modules with isolated browser/storage/network doubles.
// Run: node --test tests/capture-exclusions.test.cjs
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const assert = require('node:assert/strict')
const { test } = require('node:test')
const ts = require('typescript')
const root = path.resolve(__dirname, '..')

function harness(rules = { hostnames: [], urlPrefixes: [] }) {
    let tab = {
        id: 1,
        url: 'https://allowed.example/page',
        title: 'Allowed',
        incognito: false,
    }
    let previous
    const sent = []
    const logs = []
    const cache = {}
    const storage = {
        getEnabled: async () => true,
        getHeartbeatData: async () => previous,
        setHeartbeatData: async (data) => {
            previous = data
        },
        getProfileName: async () => '',
        getCaptureExclusions: async () => rules,
    }
    const mocks = {
        'webextension-polyfill': {},
        './helpers': {
            getActiveWindowTab: async () => tab,
            getTab: async () => tab,
            getTabs: async () => [tab],
        },
        '../config': {
            heartbeat: { intervalInSeconds: 60, alarmName: 'heartbeat' },
        },
        'aw-client': {},
        './client': {
            getBucketId: async () => 'synthetic',
            sendHeartbeat: async (_c, _b, timestamp, data, pulsetime) => {
                sent.push({ timestamp: timestamp.getTime(), data, pulsetime })
            },
        },
        '../storage': storage,
        'deep-equal': (a, b) => JSON.stringify(a) === JSON.stringify(b),
        'punycode.js': require('punycode.js'),
    }
    function load(filename) {
        if (cache[filename]) return cache[filename]
        const exports = {}
        cache[filename] = exports
        const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true,
            },
        }).outputText
        vm.runInNewContext(output, {
            exports,
            URL,
            Date,
            console: Object.fromEntries(
                ['debug', 'warn', 'error'].map((level) => [
                    level,
                    (...args) => logs.push(args.join(' ')),
                ]),
            ),
            require: (name) =>
                name in mocks
                    ? mocks[name]
                    : load(path.resolve(path.dirname(filename), name + '.ts')),
        })
        return exports
    }
    const heartbeat = load(path.join(root, 'src/background/heartbeat.ts'))
    return {
        sent,
        logs,
        rules,
        get previous() {
            return previous
        },
        setTab(url, title = 'Private title') {
            tab = { ...tab, url, title }
        },
        tick: () => heartbeat.sendInitialHeartbeat({}),
        activate: () => heartbeat.tabActivatedListener({})({ tabId: 1 }),
        alarm: () =>
            heartbeat.heartbeatAlarmListener({})({ name: 'heartbeat' }),
        update: () =>
            heartbeat.tabUpdatedListener({})(1, { url: tab.url }, tab),
    }
}

test('empty defaults preserve previous/current sends', async () => {
    const h = harness()
    await h.tick()
    h.setTab('https://other.example/', 'Other')
    await h.tick()
    assert.equal(h.sent.length, 3)
    assert.equal(h.sent[1].data.url, 'https://allowed.example/page')
    assert.equal(h.sent[2].data.url, 'https://other.example/')
})

for (const listener of ['tick', 'activate', 'alarm', 'update']) {
    test(`${listener} never sends or logs excluded URL/title`, async () => {
        const h = harness({ hostnames: [], urlPrefixes: ['chrome://newtab/'] })
        h.setTab('chrome://newtab/', 'Sensitive new tab title')
        await h[listener]()
        assert.equal(h.sent.length, 0)
        assert.ok(!h.logs.join('\n').includes('chrome://newtab/'))
        assert.ok(!h.logs.join('\n').includes('Sensitive new tab title'))
        assert.equal(h.previous, null)
    })
}

test('exact hostnames ignore case but not subdomains or suffix lookalikes', async () => {
    const h = harness({ hostnames: ['PRIVATE.EXAMPLE'], urlPrefixes: [] })
    for (const url of [
        'https://private.example/a',
        'http://private.example:8080/b',
    ]) {
        h.setTab(url)
        await h.tick()
    }
    assert.equal(h.sent.length, 0)
    h.setTab('https://sub.private.example/')
    await h.tick()
    h.setTab('https://private.example.evil/')
    await h.tick()
    assert.equal(h.sent.length, 3)
})

test('tracked → excluded → same tracked URL starts a new pulse without replay', async () => {
    const h = harness({ hostnames: ['private.example'], urlPrefixes: [] })
    await h.tick()
    h.setTab('https://private.example/secret', 'Secret')
    await h.tick()
    assert.equal(h.previous, null)
    h.setTab('https://allowed.example/page', 'Allowed')
    await h.tick()
    assert.equal(h.sent.length, 2)
    assert.equal(h.sent[1].pulsetime, 0)
    await h.tick()
    assert.equal(h.sent[2].pulsetime, 80)
})

test('new rules exclude remembered data before previous-payload logging/replay', async () => {
    const h = harness()
    await h.tick()
    h.logs.length = 0
    h.rules.hostnames.push('allowed.example')
    h.setTab('https://other.example/', 'Other')
    await h.tick()
    assert.equal(h.sent.length, 2)
    assert.equal(h.sent[1].data.url, 'https://other.example/')
    assert.ok(!h.logs.join('\n').includes('allowed.example'))
    assert.equal(h.sent[1].pulsetime, 0)
})

test('queued exclusion transition retains ordering', async () => {
    const h = harness({ hostnames: ['private.example'], urlPrefixes: [] })
    await h.tick()
    h.setTab('https://private.example/secret')
    const excluded = h.update()
    h.setTab('https://allowed.example/page', 'Allowed')
    const returned = h.update()
    await Promise.all([excluded, returned])
    assert.equal(h.sent.length, 2)
    assert.equal(h.sent[1].pulsetime, 0)
    assert.ok(!h.logs.join('\n').includes('private.example'))
})
