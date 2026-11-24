// A hostname that could not be detected at install time (server not yet
// running) must be retried when the background script starts again, or events
// keep going to the hostname-less "unknown" bucket until the next update.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function loadSource(path, mocks, globals = {}) {
    const source = readFileSync(
        new URL(`../src/${path}`, import.meta.url),
        'utf8',
    )
    const exports = {}
    vm.runInNewContext(
        ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2020,
                esModuleInterop: true,
            },
        }).outputText,
        {
            exports,
            ...globals,
            require(name) {
                assert.ok(name in mocks, `Unexpected dependency: ${name}`)
                return mocks[name]
            },
            console: { info() {}, debug() {}, error() {}, warn() {} },
        },
    )
    return exports
}

async function startWorker({
    hostname,
    detected,
    writeDelayMs = 0,
    duringDetection,
    clock = { now: 1000 },
    enabledRead,
    realHeartbeat = false,
}) {
    const state = { enabled: true, hostname }
    const detectCalls = []
    const activatedListeners = []
    const activatedHostnames = []
    const activatedTimes = []
    const sent = []
    const tab = { id: 1, url: 'https://before.test/', title: 'Before' }
    let pendingActivation
    let releaseHeartbeat
    const initialHeartbeat = new Promise((resolve) => {
        releaseHeartbeat = resolve
    })
    const noopEvent = { addListener() {}, removeListener() {} }
    const browser = {
        runtime: {
            onInstalled: noopEvent,
            onStartup: noopEvent,
            onMessage: noopEvent,
            getURL: (path) => path,
        },
        storage: {
            managed: {
                async get() {
                    return {}
                },
            },
            local: {
                async get(keys) {
                    if (keys.includes('enabled') && enabledRead)
                        await enabledRead()
                    return Object.fromEntries(
                        (Array.isArray(keys) ? keys : [keys])
                            .filter((key) => state[key] !== undefined)
                            .map((key) => [key, state[key]]),
                    )
                },
                async set(data) {
                    if (writeDelayMs) {
                        await new Promise((r) => setTimeout(r, writeDelayMs))
                    }
                    Object.assign(state, data)
                },
                onChanged: noopEvent,
            },
        },
        tabs: {
            async create() {},
            onActivated: {
                addListener: (listener) => activatedListeners.push(listener),
            },
            onUpdated: noopEvent,
        },
        alarms: { create() {}, onAlarm: noopEvent },
    }
    const storage = loadSource('storage.ts', {
        'webextension-polyfill': browser,
    })
    const ClockDate = class extends Date {
        constructor(...args) {
            if (args.length) super(...args)
            else super(clock.now)
        }
    }
    const productionHeartbeat = realHeartbeat
        ? loadSource(
              'background/heartbeat.ts',
              {
                  'webextension-polyfill': browser,
                  './helpers': {
                      getTab: async () => ({ ...tab }),
                      getActiveWindowTab: async () => ({ ...tab }),
                      getTabs: async () => [{ ...tab }],
                      getTabGroup: async () => undefined,
                  },
                  '../config': {
                      heartbeat: {
                          alarmName: 'heartbeat',
                          intervalInSeconds: 60,
                      },
                  },
                  'aw-client': {},
                  './client': {
                      getBucketId: async () => 'bucket',
                      sendHeartbeat: async (
                          _client,
                          _bucket,
                          timestamp,
                          data,
                      ) => {
                          sent.push({ timestamp, data })
                      },
                  },
                  '../storage': storage,
                  'deep-equal': (a, b) =>
                      JSON.stringify(a) === JSON.stringify(b),
                  'punycode.js': {},
              },
              { Date: ClockDate },
          )
        : undefined
    let hostnameAtHeartbeat
    loadSource(
        'background/main.ts',
        {
            'webextension-polyfill': browser,
            '../config': {
                requireConsent: false,
                heartbeat: { alarmName: 'heartbeat', intervalInSeconds: 60 },
            },
            './heartbeat': {
                heartbeatAlarmListener() {},
                async sendInitialHeartbeat() {
                    hostnameAtHeartbeat = state.hostname
                    releaseHeartbeat()
                },
                tabActivatedListener:
                    productionHeartbeat?.tabActivatedListener ??
                    ((_client, ready) =>
                        async (_info, now = new Date(clock.now)) => {
                            const enabled = await storage.getEnabled()
                            if (!enabled) return
                            await ready
                            activatedHostnames.push(state.hostname)
                            activatedTimes.push(now.getTime())
                        }),
                tabUpdatedListener() {},
            },
            './client': {
                getClient: () => ({ baseURL: 'http://synthetic.invalid' }),
                async loadApiKey() {},
                async detectHostname() {
                    detectCalls.push(true)
                    if (duringDetection) {
                        pendingActivation = duringDetection({
                            state,
                            tab,
                            fireActivated: () =>
                                Promise.all(
                                    activatedListeners.map((listener) =>
                                        listener({ tabId: 1, windowId: 1 }),
                                    ),
                                ),
                        })
                    }
                    await new Promise((r) => setTimeout(r, 10))
                    return detected
                },
            },
            './consent': loadSource('background/consent.ts', {}),
            '../storage': storage,
        },
        { Date: ClockDate },
    )
    await Promise.race([
        initialHeartbeat,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('no initial heartbeat')), 1000),
        ),
    ])
    await pendingActivation
    return {
        state,
        detectCalls,
        hostnameAtHeartbeat,
        activatedHostnames,
        activatedTimes,
        sent,
    }
}

test('startup detects a hostname that install-time detection missed', async () => {
    const result = await startWorker({
        hostname: undefined,
        detected: 'real-host',
    })
    assert.equal(result.hostnameAtHeartbeat, 'real-host')
    assert.equal(result.state.hostname, 'real-host')
})

test('startup keeps an existing (detected or user-set) hostname', async () => {
    const result = await startWorker({
        hostname: 'user-set',
        detected: 'real-host',
    })
    assert.equal(result.detectCalls.length, 0)
    assert.equal(result.state.hostname, 'user-set')
})

test('startup still sends the initial heartbeat when the server is down', async () => {
    const result = await startWorker({
        hostname: undefined,
        detected: undefined,
    })
    assert.equal(result.state.hostname, undefined)
    assert.equal(result.detectCalls.length, 1)
})

test('tab events during detection wait for it, not the hostname-less bucket', async () => {
    const result = await startWorker({
        hostname: undefined,
        detected: 'real-host',
        duringDetection: ({ fireActivated }) => fireActivated(),
    })
    assert.deepEqual(result.activatedHostnames, ['real-host'])
})

test('a hostname saved while detection is in flight is not overwritten', async () => {
    const result = await startWorker({
        hostname: undefined,
        detected: 'real-host',
        duringDetection: async ({ state }) => {
            state.hostname = 'user-set'
        },
    })
    assert.equal(result.state.hostname, 'user-set')
})

test('the initial heartbeat waits for the detected hostname to be stored', async () => {
    const result = await startWorker({
        hostname: undefined,
        detected: 'real-host',
        writeDelayMs: 20,
    })
    assert.equal(result.hostnameAtHeartbeat, 'real-host')
})

test('tab events before consent are discarded while hostname detection waits', async () => {
    const result = await startWorker({
        detected: 'real-host',
        duringDetection: async ({ state, fireActivated }) => {
            state.enabled = false
            const pending = fireActivated()
            await Promise.resolve()
            state.enabled = true
            await pending
        },
    })
    assert.deepEqual(result.activatedHostnames, [])
})

test('tab timestamps are captured before waiting for hostname detection', async () => {
    const clock = { now: 1000 }
    const result = await startWorker({
        detected: 'real-host',
        clock,
        realHeartbeat: true,
        duringDetection: ({ fireActivated }) => {
            const first = fireActivated()
            clock.now = 2000
            const second = fireActivated()
            clock.now = 9000
            return Promise.all([first, second])
        },
    })
    assert.deepEqual(
        result.sent.map((event) => event.timestamp.getTime()),
        [1000, 2000],
    )
})

test('tabs are not read until a delayed enabled read completes', async () => {
    let release
    const gate = new Promise((resolve) => {
        release = resolve
    })
    let reads = 0
    const result = await startWorker({
        detected: 'real-host',
        realHeartbeat: true,
        enabledRead: async () => {
            if (++reads === 1) await gate
        },
        duringDetection: async ({ fireActivated, tab }) => {
            const pending = fireActivated()
            await new Promise((resolve) => setImmediate(resolve))
            tab.url = 'https://later.test/'
            tab.title = 'Later'
            release()
            await pending
        },
    })
    // Consent comes first: the tab is read only after tracking is confirmed
    // enabled, so it describes the tab at that moment.
    assert.equal(result.sent.length, 1)
    assert.equal(result.sent[0].data.url, 'https://later.test/')
})
