import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

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
