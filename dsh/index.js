// DeepSeek Harness plugin entry. It adds one skill source that sees only this
// package's skills folder, so DSH loads the same SKILL.md and scripts that
// Claude Code, Codex and ZCode use. The skill itself lives in plugins/ only.
import { fileURLToPath } from 'node:url'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

export const name = '88api-image-gen'

export const SKILLS_ROOT = fileURLToPath(new URL('../plugins/88api-image-gen/skills', import.meta.url))

export function skillSourceConfig() {
  return {
    providerName: '88api-image-gen',
    includeDefaultRoots: false,
    customSkillDirs: [SKILLS_ROOT],
    // The installed package only changes on reinstall.
    watch: false,
  }
}

export function apply(ctx) {
  ctx.plugin(skillFilesystem, skillSourceConfig())
}
