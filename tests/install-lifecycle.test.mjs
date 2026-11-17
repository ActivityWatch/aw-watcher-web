// Execute the real install listener, consent gate and storage accessors with
// synthetic browser storage. No browser profile or network is accessed.
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

async function install({ reason, enabled, consent, requireConsent, managed }) {
    const state = { enabled, consent, hostname: 'synthetic-host' }
    const listeners = []
    const enabledWrites = []
    const consentPages = []
    const noopEvent = { addListener() {}, removeListener() {} }
    const browser = {
        runtime: {
            onInstalled: {
                addListener: (listener) => listeners.push(listener),
            },
            onStartup: noopEvent,
            onMessage: noopEvent,
            getURL: (path) => path,
        },
        storage: {
            managed: {
                async get() {
                    return managed
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
                    if ('enabled' in data) enabledWrites.push(data.enabled)
                    Object.assign(state, data)
                },
                onChanged: noopEvent,
            },
        },
        tabs: {
            async create(tab) {
                consentPages.push(tab)
            },
            onActivated: noopEvent,
            onUpdated: noopEvent,
        },
        alarms: { create() {}, onAlarm: noopEvent },
    }
    const storage = loadSource('storage.ts', {
        'webextension-polyfill': browser,
    })
    loadSource('background/main.ts', {
        'webextension-polyfill': browser,
        '../config': {
            requireConsent,
            heartbeat: { alarmName: 'heartbeat', intervalInSeconds: 60 },
        },
        './heartbeat': {
            heartbeatAlarmListener() {},
            sendInitialHeartbeat() {},
            tabActivatedListener() {},
            tabUpdatedListener() {},
        },
        './client': {
            getClient: () => ({ baseURL: 'http://synthetic.invalid' }),
            async loadApiKey() {},
            async detectHostname() {
                return 'synthetic-host'
            },
        },
        './consent': loadSource('background/consent.ts', {}),
        '../storage': storage,
    })
    for (const listener of listeners) await listener({ reason })
    return { state, enabledWrites, consentPages }
}

const consentModes = [
    { name: 'Chromium', requireConsent: false },
    { name: 'Firefox user consent', requireConsent: true, consent: true },
    {
        name: 'Firefox managed consent',
        requireConsent: true,
        managed: { consentOfflineDataCollection: true },
    },
]

for (const mode of consentModes) {
    for (const reason of ['install', 'update', 'chrome_update']) {
        for (const enabled of [undefined, false, true]) {
            test(`${mode.name}: ${reason} with enabled=${enabled}`, async () => {
                const result = await install({ ...mode, reason, enabled })
                const paused = reason !== 'install' && enabled === false
                assert.equal(result.state.enabled, !paused)
                assert.deepEqual(result.enabledWrites, paused ? [] : [true])
                assert.equal(result.consentPages.length, 0)
            })
        }
    }
}

for (const reason of ['install', 'update']) {
    for (const enabled of [undefined, false, true]) {
        test(`Firefox without consent: ${reason} with enabled=${enabled}`, async () => {
            const result = await install({
                reason,
                enabled,
                requireConsent: true,
            })
            assert.equal(result.state.enabled, enabled)
            assert.deepEqual(result.enabledWrites, [])
            assert.equal(result.consentPages.length, 1)
            assert.equal(result.consentPages[0].url, 'src/consent/index.html')
            assert.equal(result.state.consentRequired, true)
        })
    }
}
