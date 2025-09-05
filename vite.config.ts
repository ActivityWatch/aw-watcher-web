import { defineConfig } from 'vite'
import webExtension, { readJsonFile } from 'vite-plugin-web-extension'

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
      manifest: generateManifest,
      additionalInputs: ['src/consent/index.html', 'src/consent/main.ts'],
      browser: process.env.VITE_TARGET_BROWSER,
    }),    
  ],
})
