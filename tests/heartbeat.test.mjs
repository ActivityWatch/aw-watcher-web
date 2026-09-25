import assert from 'node:assert/strict'
import test from 'node:test'
import retry from 'p-retry'
import { FetchError } from 'aw-client'
import { loadModule } from './load-module.mjs'

function clientModule() {
    const statuses = []
    const module = loadModule('src/background/client.ts', {
        'p-retry': (fn, options) =>
            retry(fn, { ...options, minTimeout: 1, maxTimeout: 1 }),
        './helpers': { emitNotification() {}, logHttpError() {} },
        '../storage': {
            getHostname: async () => 'test-host',
            getSyncStatus: async () => ({ success: true }),
            setSyncStatus: async (success) => statuses.push(success),
        },
    })
    return { ...module, statuses }
}

const send = (module, client) =>
    module.sendHeartbeat(
        client,
        'test-bucket',
        new Date(),
        { title: 'Test' },
        80,
    )
const httpError = (status) => new FetchError(new Response(null, { status }))

test(
    'an outage reports failure, settles, and permits a later successful send',
    { timeout: 2000 },
    async () => {
        const module = clientModule()
        let attempts = 0
        const client = {
            heartbeat: async () => {
                attempts++
                throw Error('offline')
            },
            ensureBucket: async () =>
                assert.fail('network errors must not create buckets'),
        }
        assert.equal(await send(module, client), false)
        assert.equal(attempts, 4)
        assert.ok(module.statuses.every((status) => status === false))
        client.heartbeat = async () => {}
        assert.equal(await send(module, client), true)
        assert.equal(module.statuses.at(-1), true)
    },
)

test('a missing bucket is created and the heartbeat retried', async () => {
    const module = clientModule()
    let attempts = 0
    let created = 0
    assert.equal(
        await send(module, {
            heartbeat: async () => {
                if (attempts++ === 0) throw httpError(404)
            },
            ensureBucket: async (...args) => {
                assert.deepEqual(args, [
                    'test-bucket',
                    'web.tab.current',
                    'test-host',
                ])
                created++
            },
        }),
        true,
    )
    assert.equal(created, 1)
    assert.equal(attempts, 2)
})

test(
    'bucket creation failures have a finite retry budget',
    { timeout: 2000 },
    async () => {
        const module = clientModule()
        let created = 0
        assert.equal(
            await send(module, {
                heartbeat: async () => {
                    throw httpError(404)
                },
                ensureBucket: async () => {
                    created++
                    throw Error('offline')
                },
            }),
            false,
        )
        assert.equal(created, 4)
        assert.equal(module.statuses.at(-1), false)
    },
)

test('authentication failures neither retry nor attempt bucket creation', async () => {
    const module = clientModule()
    let attempts = 0
    assert.equal(
        await send(module, {
            heartbeat: async () => {
                attempts++
                throw httpError(401)
            },
            ensureBucket: async () => assert.fail('unexpected bucket creation'),
        }),
        false,
    )
    assert.equal(attempts, 1)
})

test('the heartbeat queue stays bounded and runs recent events in order after failure', async () => {
    const { createHeartbeatQueue } = loadModule(
        'src/background/heartbeatQueue.ts',
    )
    const enqueue = createHeartbeatQueue(2)
    let release
    const blocked = enqueue(
        () =>
            new Promise((_, reject) => {
                release = reject
            }),
    )
    const rejection = assert.rejects(blocked, /offline/)
    const ran = []
    const dropped = enqueue(async () => {
        ran.push('stale')
    })
    const second = enqueue(async () => {
        ran.push('second')
    })
    const third = enqueue(async () => {
        ran.push('third')
    })
    await dropped
    assert.deepEqual(ran, [])
    release(Error('offline'))
    await Promise.all([rejection, second, third])
    assert.deepEqual(ran, ['second', 'third'])
})

test('failed sends do not overwrite the last successfully recorded heartbeat', async () => {
    let writes = 0
    const tab = { id: 1, url: 'https://example.com', title: 'Example' }
    const { sendInitialHeartbeat } = loadModule('src/background/heartbeat.ts', {
        'webextension-polyfill': {},
        './hostnameInTitle': {
            originalTitle: async (_id, _url, title) => title,
        },
        './client': {
            getBucketId: async () => 'test',
            sendHeartbeat: async () => false,
        },
        './helpers': {
            getActiveWindowTab: async () => tab,
            getTabs: async () => [tab],
        },
        '../storage': {
            getEnabled: async () => true,
            getHeartbeatData: async () => undefined,
            setHeartbeatData: async () => writes++,
        },
    })
    await sendInitialHeartbeat({})
    assert.equal(writes, 0)
})
