// A hostname that could not be detected at install time (server not yet
// running) must be retried when the background script starts again, or events
// keep going to the hostname-less "unknown" bucket until the next update.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import ts from 'typescript'

function loadSource(path, mocks) {
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
            require(name) {
                assert.ok(name in mocks, `Unexpected dependency: ${name}`)
                return mocks[name]
            },
            console: { info() {}, debug() {}, error() {}, warn() {} },
        },
    )
    return exports
}

async function startWorker({ hostname, detected }) {
    const state = { enabled: true, hostname }
    const detectCalls = []
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
                    return Object.fromEntries(
                        (Array.isArray(keys) ? keys : [keys])
                            .filter((key) => state[key] !== undefined)
                            .map((key) => [key, state[key]]),
                    )
                },
                async set(data) {
                    Object.assign(state, data)
                },
                onChanged: noopEvent,
            },
        },
        tabs: {
            async create() {},
            onActivated: noopEvent,
            onUpdated: noopEvent,
        },
        alarms: { create() {}, onAlarm: noopEvent },
    }
    const storage = loadSource('storage.ts', {
        'webextension-polyfill': browser,
    })
    let hostnameAtHeartbeat
    loadSource('background/main.ts', {
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
            tabActivatedListener() {},
            tabUpdatedListener() {},
        },
        './client': {
            getClient: () => ({ baseURL: 'http://synthetic.invalid' }),
            async loadApiKey() {},
            async detectHostname() {
                detectCalls.push(true)
                return detected
            },
        },
        './consent': loadSource('background/consent.ts', {}),
        '../storage': storage,
    })
    await Promise.race([
        initialHeartbeat,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('no initial heartbeat')), 1000),
        ),
    ])
    return { state, detectCalls, hostnameAtHeartbeat }
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
