import { homedir } from 'node:os'
import { basename, dirname, join, type posix } from 'node:path'
import type { AgentType } from '../../shared/agent-status-types'
import type { Repo } from '../../shared/repo-types'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import type { SkillProvider, SkillSourceKind } from '../../shared/skills'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { resolveEnvironmentSkillProviderRoots } from './skill-provider-runtime-roots'
import { stablePathId, type SkillScanRoot } from './skill-discovery-sources'

type CommandDiscoveryPathApi = Pick<typeof posix, 'basename' | 'dirname' | 'join'>

function source(
  id: string,
  label: string,
  path: string,
  sourceKind: SkillSourceKind,
  providers: SkillProvider[],
  owner: AgentType | null
): SkillScanRoot {
  return { id, label, path, sourceKind, providers, owner }
}

function claudeProfileCommandsPath(
  home: string,
  claudeSkillsOverride: string | undefined,
  pathApi: CommandDiscoveryPathApi
): string {
  const skillsPath = claudeSkillsOverride ?? pathApi.join(home, '.claude', 'skills')
  return pathApi.join(pathApi.dirname(skillsPath), 'commands')
}

export function claudeCommandNameFromRelativePath(relPath: string, sep: string): string | null {
  if (!relPath || relPath === '..' || relPath.startsWith(`..${sep}`)) {
    return null
  }
  const withoutExtension = relPath.endsWith('.md') ? relPath.slice(0, -3) : relPath
  if (!withoutExtension) {
    return null
  }
  return withoutExtension.split(sep).join(':')
}

export function buildClaudeCommandDiscoverySources(
  args: {
    homeDir?: string
    cwd?: string
    repos?: Repo[]
    includeCwd?: boolean
    pathApi?: CommandDiscoveryPathApi
    providerRootOverrides?: SkillProviderRootOverrides
  } = {}
): SkillScanRoot[] {
  const pathApi = args.pathApi ?? { basename, dirname, join }
  const home = args.homeDir ?? homedir()
  const cwd = args.cwd ?? process.cwd()
  const providerRootOverrides =
    args.providerRootOverrides ?? (args.pathApi ? {} : resolveEnvironmentSkillProviderRoots())
  const roots: SkillScanRoot[] = [
    source(
      'home-claude-commands',
      'Claude home commands',
      claudeProfileCommandsPath(home, providerRootOverrides.claude, pathApi),
      'home',
      ['claude'],
      'claude'
    )
  ]

  const projectPaths = new Set<string>()
  for (const repo of args.repos ?? []) {
    if (getRepoExecutionHostId(repo) !== LOCAL_EXECUTION_HOST_ID) {
      continue
    }
    projectPaths.add(repo.path)
  }
  if (args.includeCwd !== false) {
    projectPaths.add(cwd)
  }

  for (const repoPath of projectPaths) {
    const label = `Repo ${pathApi.basename(repoPath)}`
    roots.push(
      source(
        `repo-claude-commands-${stablePathId(repoPath)}`,
        `${label} .claude commands`,
        pathApi.join(repoPath, '.claude', 'commands'),
        'repo',
        ['claude'],
        'claude'
      )
    )
  }

  return roots
}
