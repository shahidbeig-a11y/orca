import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  collapseDiscoveredCommandsByName,
  mergeVerifiedAndDiscoveredSlashCommands,
  toSlashCommandSuggestions
} from '../../shared/claude-slash-command-discovery'
import {
  buildClaudeCommandDiscoverySources,
  claudeCommandNameFromRelativePath
} from './claude-command-discovery-sources'
import {
  clearClaudeCommandRootScanCache,
  discoverClaudeSlashCommands
} from './claude-command-discovery'

beforeEach(() => {
  clearClaudeCommandRootScanCache()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('claudeCommandNameFromRelativePath', () => {
  it('maps nested markdown files to colon-separated command names', () => {
    expect(claudeCommandNameFromRelativePath('opsx/apply.md', '/')).toBe('opsx:apply')
    expect(claudeCommandNameFromRelativePath('deploy.md', '/')).toBe('deploy')
  })
})

describe('buildClaudeCommandDiscoverySources', () => {
  it('includes home and repo .claude/commands roots', () => {
    const roots = buildClaudeCommandDiscoverySources({
      homeDir: '/home/tester',
      cwd: '/repo/worktree'
    })
    expect(roots.map((root) => root.path)).toEqual([
      '/home/tester/.claude/commands',
      '/repo/worktree/.claude/commands'
    ])
  })
})

describe('discoverClaudeSlashCommands', () => {
  it('discovers namespaced project commands with description frontmatter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-commands-'))
    const commandsRoot = join(root, '.claude', 'commands', 'opsx')
    await mkdir(commandsRoot, { recursive: true })
    await writeFile(
      join(commandsRoot, 'apply.md'),
      '---\ndescription: Apply the current OpenSpec change\n---\n\n# Apply\n'
    )

    const result = await discoverClaudeSlashCommands({
      homeDir: join(root, 'home'),
      cwd: root,
      repos: []
    })

    expect(result.commands).toEqual([
      expect.objectContaining({
        name: 'opsx:apply',
        description: 'Apply the current OpenSpec change',
        commandFilePath: join(commandsRoot, 'apply.md'),
        sourceKind: 'repo'
      })
    ])
    expect(toSlashCommandSuggestions(result.commands)).toEqual([
      {
        name: 'opsx:apply',
        description: 'Apply the current OpenSpec change'
      }
    ])
  })

  it('builds Windows-shaped command roots with the win32 path adapter', () => {
    const roots = buildClaudeCommandDiscoverySources({
      homeDir: 'C:\\Users\\tester',
      cwd: 'C:\\repo\\worktree',
      pathApi: {
        basename: (value) => value.split(/[\\/]/).pop() ?? value,
        dirname: (value) => value.replace(/[\\/][^\\/]+$/, ''),
        join: (...parts) => parts.join('\\')
      }
    })
    expect(roots.map((root) => root.path)).toEqual([
      'C:\\Users\\tester\\.claude\\commands',
      'C:\\repo\\worktree\\.claude\\commands'
    ])
  })

  it('keeps one row per command name and prefers project over home', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-claude-commands-dup-'))
    const homeCommands = join(root, 'home', '.claude', 'commands')
    const projectCommands = join(root, 'project', '.claude', 'commands')
    await mkdir(homeCommands, { recursive: true })
    await mkdir(projectCommands, { recursive: true })
    await writeFile(join(homeCommands, 'foo.md'), '---\ndescription: Home foo\n---\n')
    await writeFile(join(projectCommands, 'foo.md'), '---\ndescription: Project foo\n---\n')

    const result = await discoverClaudeSlashCommands({
      homeDir: join(root, 'home'),
      cwd: join(root, 'project'),
      repos: []
    })

    expect(result.commands).toEqual([
      expect.objectContaining({
        name: 'foo',
        description: 'Project foo',
        commandFilePath: join(projectCommands, 'foo.md'),
        sourceKind: 'repo'
      })
    ])
  })
})

describe('collapseDiscoveredCommandsByName', () => {
  it('prefers repo commands over home commands with the same name', () => {
    const collapsed = collapseDiscoveredCommandsByName([
      {
        name: 'foo',
        description: 'Home foo',
        commandFilePath: '/home/tester/.claude/commands/foo.md',
        sourceKind: 'home',
        sourceLabel: 'Claude home commands'
      },
      {
        name: 'foo',
        description: 'Project foo',
        commandFilePath: '/repo/.claude/commands/foo.md',
        sourceKind: 'repo',
        sourceLabel: 'Repo project .claude commands'
      }
    ])
    expect(collapsed).toEqual([
      expect.objectContaining({
        name: 'foo',
        description: 'Project foo',
        sourceKind: 'repo'
      })
    ])
  })
})

describe('mergeVerifiedAndDiscoveredSlashCommands', () => {
  it('appends discovered commands without overriding verified names', () => {
    const merged = mergeVerifiedAndDiscoveredSlashCommands(
      [{ name: 'clear', description: 'Clear conversation history' }],
      [
        { name: 'opsx:apply', description: 'Apply' },
        { name: 'clear', description: 'Duplicate' }
      ]
    )
    expect(merged.map((command) => command.name)).toEqual(['clear', 'opsx:apply'])
  })
})
