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

test('every client shows the same title, description and icon', () => {
  const json = (path) => JSON.parse(read(path))
  const codex = json('plugins/88api-image-gen/.codex-plugin/plugin.json')
  const locale = json('locale/en.json').meta
  const descriptions = [
    pkg.description,
    locale.description,
    json('plugins/88api-image-gen/.claude-plugin/plugin.json').description,
    json('.claude-plugin/marketplace.json').plugins[0].description,
    codex.description,
    codex.interface.shortDescription,
    read('plugins/88api-image-gen/skills/88api-image-gen/agents/openai.yaml').match(/short_description: "(.*)"/)[1],
  ]
  assert.deepEqual(new Set(descriptions), new Set([pkg.description]))
  assert.equal(locale.title, codex.interface.displayName)
  assert.ok(pkg.files.includes('locale/') && pkg.files.includes(pkg.icon))
  assert.ok(pkg.exports['./locale/*'])
  const icon = readFileSync(`${root}/${pkg.icon}`)
  assert.ok(icon.length <= 256 * 1024, 'DSH rejects icons over 256 KiB')
  assert.ok(icon.equals(readFileSync(`${root}/plugins/88api-image-gen/${codex.interface.logo}`)))
})

test('the DSH bundle points at the entry and the shared skill', () => {
  assert.equal(pkg.main, './dsh/index.js')
  assert.ok(existsSync(`${root}/${pkg.dsh.bundle.patch}`))
  assert.match(read('dsh/cordis.patch.yml'), new RegExp(`name: ${pkg.name}\\b`))
  assert.match(read('dsh/index.js'), /\.\.\/plugins\/88api-image-gen\/skills/)
  assert.ok(pkg.files.includes('plugins/88api-image-gen/skills/'))
  assert.match(read('plugins/88api-image-gen/skills/88api-image-gen/SKILL.md'), /^---\r?\nname: 88api-image-gen\r?\n/)
})
