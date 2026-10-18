import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = readFileSync(
    new URL('../src/popup/domain-time.ts', import.meta.url),
    'utf8',
)
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
})
const { buildDomainTimeQuery, formatDuration } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
)

test('query uses local midnight through now and quotes bucket identifiers', () => {
    const now = new Date(2026, 9, 18, 14, 30)
    const result = buildDomainTimeQuery(
        'aw-watcher-web-chrome_bob',
        'https://Example.COM/path',
        now,
    )
    assert.equal(result.hostname, 'example.com')
    assert.equal(
        result.timeperiods[0],
        `${new Date(2026, 9, 18).toISOString()}/${now.toISOString()}`,
    )
    assert.equal(
        result.query[0],
        'events = query_bucket("aw-watcher-web-chrome_bob");',
    )
    assert.equal(result.query.at(-1), 'RETURN = sum_durations(events);')
    assert.equal(
        buildDomainTimeQuery('bucket"; RETURN = 123;', 'https://example.com'),
        undefined,
    )
})

test('hostname regex includes ports but not subdomains or lookalikes', () => {
    const { query } = buildDomainTimeQuery('bucket', 'https://example.com/')
    const regex = new RegExp(query[1].match(/"url", "(.*)"\);$/)[1])
    for (const url of [
        'https://example.com',
        'http://example.com/a',
        'https://example.com:8443/a',
        'https://EXAMPLE.com/?q=x',
        'https://user:pass@example.com/a',
    ]) {
        assert.ok(regex.test(url), url)
    }
    for (const url of [
        'https://sub.example.com/',
        'https://example.com.evil/',
        'https://exampleXcom/',
        'https://example.com@evil.com/',
        'https://evil.com?@example.com/',
        'https://evil.com#@example.com/',
        'file://example.com/',
    ]) {
        assert.equal(regex.test(url), false, url)
    }
})

test('IPv6 hosts are escaped, and non-web or missing URLs are unsupported', () => {
    const result = buildDomainTimeQuery('bucket', 'http://[::1]:5600/')
    const regex = new RegExp(result.query[1].match(/"url", "(.*)"\);$/)[1])
    assert.ok(regex.test('http://[::1]:5600/path'))
    for (const url of [
        undefined,
        '',
        'not a URL',
        'about:blank',
        'chrome://extensions',
        'file:///tmp/page',
        'ftp://example.com',
    ]) {
        assert.equal(buildDomainTimeQuery('bucket', url), undefined)
    }
})

test('durations show zero, sub-minute, minutes and hours without rounding up', () => {
    assert.equal(formatDuration(0), '0m')
    assert.equal(formatDuration(12.5), '<1m')
    assert.equal(formatDuration(60), '1m')
    assert.equal(formatDuration(4319), '1h 11m')
    assert.equal(formatDuration(7200), '2h 0m')
})
