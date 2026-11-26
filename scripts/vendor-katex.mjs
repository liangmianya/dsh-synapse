#!/usr/bin/env node
/**
 * Refresh `vendor/katex/` from the published KaTeX package.
 *
 * The plugin stays offline and dependency-free: the browser build, stylesheet
 * and the woff2 fonts are committed, and the host serves them from
 * `/synapse/vendor/katex/`. Run `pnpm run vendor:math` after editing
 * KATEX_VERSION, then commit the result. `pnpm run vendor:math -- --check`
 * verifies the committed copy without touching it.
 */
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const run = promisify(execFile)

const KATEX_VERSION = '0.19.1'
const root = fileURLToPath(new URL('..', import.meta.url))
const target = join(root, 'vendor', 'katex')

// Keep this list in sync with the whitelist in index.js: only the files the
// page actually requests are published.
const files = ['katex.min.js', 'katex.min.css']

const expectedFonts = async () => (await readdir(join(target, 'fonts'))).filter(name => name.endsWith('.woff2'))

async function check() {
  const version = await readFile(join(target, 'VERSION'), 'utf8').catch(() => '')
  if (version.trim() !== KATEX_VERSION) {
    throw new Error(`vendor/katex/VERSION is ${version.trim() || 'missing'}, expected ${KATEX_VERSION}; run pnpm run vendor:math`)
  }
  const build = await readFile(join(target, 'katex.min.js'), 'utf8')
  if (!build.includes(`version:"${KATEX_VERSION}"`) && !build.includes(`"${KATEX_VERSION}"`)) {
    throw new Error('vendor/katex/katex.min.js does not carry the expected version')
  }
  for (const name of [...files, 'LICENSE']) {
    if (!existsSync(join(target, name))) throw new Error(`vendor/katex/${name} is missing`)
  }
  const fonts = await expectedFonts()
  if (fonts.length !== 20) throw new Error(`vendor/katex/fonts has ${fonts.length} woff2 files, expected 20`)
}

/**
 * Download the published tarball without relying on a package manager being on
 * PATH (Windows resolves `npm` only through a .cmd shim that `spawn` refuses).
 */
async function download(staging) {
  const registries = [process.env.KATEX_REGISTRY, process.env.npm_config_registry,
    'https://registry.npmjs.org', 'https://registry.npmmirror.com']
    .filter(Boolean).map(value => String(value).replace(/\/+$/, ''))
  for (const registry of registries) {
    try {
      const response = await fetch(`${registry}/katex/-/katex-${KATEX_VERSION}.tgz`)
      if (!response.ok) continue
      const archive = join(staging, 'katex.tgz')
      await writeFile(archive, Buffer.from(await response.arrayBuffer()))
      return archive
    } catch { /* try the next registry */ }
  }
  throw new Error(`could not download katex@${KATEX_VERSION}; set KATEX_REGISTRY to a reachable npm registry`)
}

async function refresh() {
  const staging = await mkdtemp(join(tmpdir(), 'dsh-synapse-katex-'))
  try {
    const archive = await download(staging)
    await run('tar', ['-xzf', archive, '-C', staging])
    const dist = join(staging, 'package', 'dist')
    await mkdir(join(target, 'fonts'), { recursive: true })
    for (const name of files) await copyFile(join(dist, name), join(target, name))
    await copyFile(join(staging, 'package', 'LICENSE'), join(target, 'LICENSE'))
    const fonts = (await readdir(join(dist, 'fonts'))).filter(name => name.endsWith('.woff2'))
    if (fonts.length === 0) throw new Error('the KaTeX package shipped no woff2 fonts')
    for (const name of fonts) await copyFile(join(dist, 'fonts', name), join(target, 'fonts', name))
    await writeFile(join(target, 'VERSION'), `${KATEX_VERSION}\n`, 'utf8')
    console.log(`vendor/katex refreshed: KaTeX ${KATEX_VERSION}, ${fonts.length} woff2 fonts`)
  } finally {
    await rm(staging, { recursive: true, force: true })
  }
}

if (process.argv.includes('--check')) await check()
else {
  await refresh()
  await check()
}
