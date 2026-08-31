import { describe, expect, it } from 'vitest'
import type { SkillScanRoot } from './skill-discovery-sources'
import {
  buildWslClaudeCommandDiscoveryCommand,
  parseWslClaudeCommandDiscoveryOutput
} from './claude-command-discovery-wsl'

function homeRoot(path: string): SkillScanRoot {
  return {
    id: 'home-claude-commands',
    label: 'Claude home commands',
    path,
    sourceKind: 'home',
    providers: ['claude'],
    owner: 'claude'
  }
}

function repoRoot(path: string): SkillScanRoot {
  return {
    id: 'repo-claude-commands',
    label: 'Repo project .claude commands',
    path,
    sourceKind: 'repo',
    providers: ['claude'],
    owner: 'claude'
  }
}

describe('parseWslClaudeCommandDiscoveryOutput', () => {
  it('parses namespaced markdown commands from WSL scan output', () => {
    const roots = [homeRoot('/home/tester/.claude/commands')]
    const markdown = Buffer.from('---\ndescription: Apply change\n---\n').toString('base64')
    const output = [
      'R',
      '0',
      '1',
      'C',
      '0',
      '/home/tester/.claude/commands/opsx/apply.md',
      '42',
      markdown,
      ''
    ].join('\0')

    const result = parseWslClaudeCommandDiscoveryOutput(output, roots, 99)
    expect(result.scannedAt).toBe(99)
    expect(result.commands).toEqual([
      expect.objectContaining({
        name: 'opsx:apply',
        description: 'Apply change',
        commandFilePath: '/home/tester/.claude/commands/opsx/apply.md',
        sourceKind: 'home'
      })
    ])
  })

  it('builds a find command that matches markdown files', () => {
    const script = buildWslClaudeCommandDiscoveryCommand([
      homeRoot('/home/tester/.claude/commands')
    ])
    expect(script).toContain("-name '*.md'")
    expect(script).toContain('/home/tester/.claude/commands')
  })

  it('keeps one row per command name and prefers project over home', () => {
    const roots = [
      homeRoot('/home/tester/.claude/commands'),
      repoRoot('/repo/project/.claude/commands')
    ]
    const homeMarkdown = Buffer.from('---\ndescription: Home foo\n---\n').toString('base64')
    const projectMarkdown = Buffer.from('---\ndescription: Project foo\n---\n').toString('base64')
    const output = [
      'R',
      '0',
      '1',
      'R',
      '1',
      '1',
      'C',
      '0',
      '/home/tester/.claude/commands/foo.md',
      '42',
      homeMarkdown,
      'C',
      '1',
      '/repo/project/.claude/commands/foo.md',
      '43',
      projectMarkdown,
      ''
    ].join('\0')

    const result = parseWslClaudeCommandDiscoveryOutput(output, roots, 99)
    expect(result.commands).toEqual([
      expect.objectContaining({
        name: 'foo',
        description: 'Project foo',
        commandFilePath: '/repo/project/.claude/commands/foo.md',
        sourceKind: 'repo'
      })
    ])
  })
})
