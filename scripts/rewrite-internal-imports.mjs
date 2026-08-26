/**
 * The `packages/*` split is a development convenience. The published unit is the
 * root package, and the workspace names (`@quantum-box/photon-core` and friends)
 * are private — they never reach a registry and npm never places them in a
 * consuming app's `node_modules`. tsc emits those names verbatim, so
 * `@quantum-box/photon/react` and `/wasm` fail to resolve for everyone outside
 * this repository.
 *
 * Rewrite them to relative paths inside the same tarball. Not a bundle: a copy
 * of the core per entrypoint would mean two `KernelUnavailableError` classes and
 * two module-level caches, so the relative path keeps exactly one instance.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(repoRoot, 'packages')

/** Workspace package name -> the built entry a sibling package should point at. */
const entryByName = new Map()
for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue
  const manifestPath = join(packagesDir, pkg.name, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  entryByName.set(manifest.name, join(packagesDir, pkg.name, 'dist', 'index.js'))
}

const internalSpecifier = /(['"])(@quantum-box\/photon-[a-z-]+)\1/g

let rewritten = 0
for (const pkg of readdirSync(packagesDir, { withFileTypes: true })) {
  if (!pkg.isDirectory()) continue
  const distDir = join(packagesDir, pkg.name, 'dist')
  let entries
  try {
    entries = readdirSync(distDir, { recursive: true, withFileTypes: true })
  } catch {
    continue // not built; the caller's build step reports that
  }

  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!entry.name.endsWith('.js') && !entry.name.endsWith('.d.ts')) continue

    const filePath = join(entry.parentPath ?? entry.path, entry.name)
    const source = readFileSync(filePath, 'utf8')
    if (!source.includes('@quantum-box/photon-')) continue

    const output = source.replace(internalSpecifier, (match, quote, name) => {
      const target = entryByName.get(name)
      if (!target) throw new Error(`${filePath}: unknown workspace package ${name}`)

      let specifier = relative(dirname(filePath), target).replaceAll('\\', '/')
      if (!specifier.startsWith('.')) specifier = `./${specifier}`
      return `${quote}${specifier}${quote}`
    })

    if (output === source) continue
    writeFileSync(filePath, output)
    rewritten += 1
  }
}

console.log(`rewrote workspace imports in ${rewritten} built file(s)`)
