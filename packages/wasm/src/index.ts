/**
 * Loader for the Photon Engine WASM kernel.
 *
 * The kernel is required, not optional. An earlier implementation silently fell
 * back to a shallow JavaScript merge when the module failed to load, which is
 * not CRDT semantics — the same edits produced different results depending on
 * whether a network fetch happened to succeed. Loading now fails loudly.
 */

import { KernelUnavailableError, type PhotonKernelModule } from '@quantum-box/photon-core'

export interface LoadKernelOptions {
  /**
   * Where to find `photon_engine_bg.wasm`. Bundlers resolve this automatically;
   * pass it when the asset is served from a custom path, or pass the bytes
   * directly.
   */
  readonly wasm?: string | URL | BufferSource | WebAssembly.Module
  /** Pre-initialized module, e.g. one the host's bundler already produced. */
  readonly module?: PhotonKernelModule
}

let cached: Promise<PhotonKernelModule> | null = null
let registeredSource: string | URL | BufferSource | WebAssembly.Module | null = null

/**
 * Tell the loader where the payload is, once, before anything loads it.
 *
 * There is no portable way to locate a bundler-emitted asset from inside a
 * Node process: under Vitest with a jsdom environment `import.meta.url` is an
 * http URL served by Vite, and under SSR it is a file URL. Rather than guess,
 * hosts in those environments hand us the bytes.
 */
export function setPhotonKernelSource(
  wasm: string | URL | BufferSource | WebAssembly.Module,
): void {
  registeredSource = wasm
}

export async function loadPhotonKernel(
  options: LoadKernelOptions = {},
): Promise<PhotonKernelModule> {
  if (options.module) return options.module
  cached ??= importKernel(options.wasm ?? registeredSource ?? undefined).catch((error: unknown) => {
    // Do not memoize a failure: a transient asset 404 should stay retryable.
    cached = null
    throw new KernelUnavailableError(error)
  })
  return cached
}

async function importKernel(
  wasm?: string | URL | BufferSource | WebAssembly.Module,
): Promise<PhotonKernelModule> {
  const glue = await import('../../../crates/photon-engine/pkg/photon_engine.js')
  await glue.default({ module_or_path: wasm ?? (await defaultWasmSource()) })
  return glue as unknown as PhotonKernelModule
}

/**
 * `wasm-pack --target web` fetches the payload over HTTP relative to the
 * document. Under Node — Vitest, SSR, a worker script — there is no document,
 * so that relative URL resolves against localhost and the fetch fails. Read the
 * bytes off disk instead whenever the module resolves to a file URL.
 */
async function defaultWasmSource(): Promise<string | URL | BufferSource> {
  const url = new URL('../../../crates/photon-engine/pkg/photon_engine_bg.wasm', import.meta.url)
  if (url.protocol !== 'file:') return url

  // Indirect specifier so browser bundlers do not try to resolve node:fs.
  const nodeFs = 'node:fs/promises'
  const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as {
    readFile: (path: URL) => Promise<{ buffer: ArrayBufferLike; byteOffset: number; byteLength: number }>
  }
  const bytes = await readFile(url)
  return new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength)
}

export { KernelUnavailableError }
