import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import ts from 'typescript'

const require = createRequire(import.meta.url)

// Run the real TypeScript modules with browser APIs supplied by each test.
// No bundler, browser installation, or extra test dependency is needed.
// `onContext` receives the module's global object, for tests that need to
// inspect globals a script defines.
export function loadModule(entry, mocks = {}, globals = {}, onContext) {
    const context = vm.createContext({
        console: { info() {}, debug() {}, warn() {}, error() {} },
        URL,
        Date,
        Error,
        TypeError,
        setTimeout,
        clearTimeout,
        __env: { VITE_TARGET_BROWSER: 'chrome', DEV: false },
        ...globals,
    })
    const cache = new Map()
    function load(filename) {
        if (cache.has(filename)) return cache.get(filename).exports
        const module = { exports: {} }
        cache.set(filename, module)
        const source = fs
            .readFileSync(filename, 'utf8')
            .replaceAll('import.meta.env', '__env')
        const { outputText } = ts.transpileModule(source, {
            compilerOptions: {
                module: ts.ModuleKind.CommonJS,
                target: ts.ScriptTarget.ES2022,
                esModuleInterop: true,
            },
        })
        const localRequire = (id) => {
            if (Object.hasOwn(mocks, id)) return mocks[id]
            if (id.startsWith('.')) {
                return load(path.resolve(path.dirname(filename), `${id}.ts`))
            }
            return require(id)
        }
        const run = vm.runInContext(
            `(function(require, module, exports) {${outputText}\n})`,
            context,
            { filename },
        )
        run(localRequire, module, module.exports)
        return module.exports
    }
    onContext?.(context)
    return load(path.resolve(entry))
}

export const flush = () => new Promise((resolve) => setImmediate(resolve))

export function event() {
    const listeners = []
    return {
        addListener: (listener) => listeners.push(listener),
        emit: (...args) =>
            Promise.all(listeners.map((listener) => listener(...args))),
    }
}
