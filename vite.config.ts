import { defineConfig } from 'vite'
import webExtension, { readJsonFile } from 'vite-plugin-web-extension'
import { copyFileSync, existsSync } from 'fs'
import { resolve } from 'path'

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
    // Custom plugin to copy logo file
    {
      name: 'copy-logo',
      buildStart() {
        const logoSrc = resolve('media/logo/logo-128.png')
        const logoDest = resolve('build/logo-128.png')
        if (existsSync(logoSrc)) {
          copyFileSync(logoSrc, logoDest)
          console.log('Copied logo-128.png to build directory')
        } else {
          console.warn('Logo file not found at media/logo/logo-128.png')
        }
      },
    },
  ],
})
