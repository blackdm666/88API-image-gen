// Checks that the DeepSeek Harness package ships the one shared skill folder.
// The plugin entry itself needs DSH's built-in packages, so it is tested inside DSH.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const pkg = JSON.parse(read('package.json'))

test('package version matches the plugin version', () => {
  assert.equal(pkg.version, read('VERSION.txt').trim())
  for (const manifest of ['.claude-plugin', '.codex-plugin']) {
    assert.equal(JSON.parse(read(`plugins/88api-image-gen/${manifest}/plugin.json`)).version, pkg.version)
  }
  assert.match(read('plugins/88api-image-gen/skills/88api-image-gen/scripts/generate.mjs'), new RegExp(`PLUGIN_VERSION = "${pkg.version.replace(/\./g, '\\.')}"`))
})

test('the DSH bundle points at the entry and the shared skill', () => {
  assert.equal(pkg.main, './dsh/index.js')
  assert.ok(existsSync(`${root}/${pkg.dsh.bundle.patch}`))
  assert.match(read('dsh/cordis.patch.yml'), new RegExp(`name: ${pkg.name}\\b`))
  assert.match(read('dsh/index.js'), /\.\.\/plugins\/88api-image-gen\/skills/)
  assert.ok(pkg.files.includes('plugins/88api-image-gen/skills/'))
  assert.match(read('plugins/88api-image-gen/skills/88api-image-gen/SKILL.md'), /^---\r?\nname: 88api-image-gen\r?\n/)
})
