import { defineConfig } from 'vite'
import webExtension, { readJsonFile } from 'vite-plugin-web-extension'

function loadWebExtConfig() {
  try {
    return require('./.web-ext.config.json')
  } catch {
    return undefined
  }
}

function generateManifest() {
  const manifest = readJsonFile('src/manifest.json')
  const pkg = readJsonFile('package.json')
  return {
    name: pkg.name,
    description: pkg.description,
    version: pkg.version,
    ...manifest,
  }
}

export default defineConfig({
  build: {
    minify: false,
    outDir: 'build',
  },
  plugins: [
    webExtension({
      webExtConfig: loadWebExtConfig(),
      manifest: generateManifest,
      additionalInputs: [
        'src/consent/index.html',
        'src/consent/main.ts',
        'media/logo/logo-128.png',
      ],
      browser: process.env.VITE_TARGET_BROWSER,
    }),
  ],
})
