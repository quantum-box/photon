import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

import { setPhotonKernelSource } from '@quantum-box/photon-wasm'

afterEach(() => {
  cleanup()
})

Object.defineProperty(window, 'matchMedia', {
  configurable: true,
  value: (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
  }),
})

function createMemoryStorage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  }
}

const storage = createMemoryStorage()
const sessionStorage = createMemoryStorage()

Object.defineProperty(window, 'localStorage', {
  configurable: true,
  value: storage,
})

Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: storage,
})

Object.defineProperty(window, 'sessionStorage', {
  configurable: true,
  value: sessionStorage,
})

Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: sessionStorage,
})

// The WASM kernel is mandatory — there is no JavaScript fallback — but a jsdom
// environment cannot fetch the asset the way a real page does. Hand the loader
// the bytes so unit tests exercise the real kernel rather than a stub.
// Resolved from the Vitest root rather than `import.meta.url`: under jsdom
// that is an http URL served by Vite, not a file path.
setPhotonKernelSource(
  readFileSync(resolve(process.cwd(), '../../crates/photon-engine/pkg/photon_engine_bg.wasm')),
)
