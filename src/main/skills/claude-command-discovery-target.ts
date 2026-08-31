import type { Repo } from '../../shared/repo-types'
import type { ClaudeSlashCommandDiscoveryResult } from '../../shared/claude-slash-command-discovery'
import type { SkillDiscoveryTarget } from '../../shared/skills'
import {
  clearClaudeCommandRootScanCache,
  discoverClaudeSlashCommands
} from './claude-command-discovery'
import { discoverClaudeSlashCommandsInWsl } from './claude-command-discovery-wsl'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import {
  isSkillRootUnavailableError,
  SkillScanCoalescer
} from './skill-scan-coalescer'
import {
  resolveSkillDiscoveryTarget,
  type ResolvedSkillDiscoveryTarget
} from './skill-discovery-target'
import { stablePathId } from './skill-discovery-sources'
import { getRepoExecutionHostId } from '../../shared/execution-host'

const WSL_RESULT_TTL_MS = 10_000
const MAX_CACHED_COMMAND_TARGETS = 32

const targetScans = new SkillScanCoalescer<ClaudeSlashCommandDiscoveryResult>(
  MAX_CACHED_COMMAND_TARGETS
)

export function clearClaudeCommandDiscoveryCaches(): void {
  targetScans.clear()
  clearClaudeCommandRootScanCache()
}

function repoDigest(repos: readonly Repo[]): string {
  return stablePathId(
    repos
      .map((repo) => `${getRepoExecutionHostId(repo)}\0${repo.path}`)
      .sort((left, right) => left.localeCompare(right))
      .join('\0')
  )
}

function scanKey(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[],
  providerRootOverrides: SkillProviderRootOverrides | undefined
): string {
  const providerRoots = stablePathId(
    Object.entries(providerRootOverrides ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([provider, root]) => `${provider}\0${root}`)
      .join('\0')
  )
  const targetKey =
    target.kind === 'wsl'
      ? `wsl\0${target.distro}\0${target.homeDir}\0${target.cwd}`
      : `native\0${target.cwd ?? ''}\0${target.cwd ? '' : repoDigest(repos)}`
  return `commands\0${targetKey}\0${providerRoots}`
}

export async function discoverClaudeSlashCommandsOnTarget(
  target: ResolvedSkillDiscoveryTarget,
  repos: readonly Repo[],
  options: { refresh?: boolean; providerRootOverrides?: SkillProviderRootOverrides } = {}
): Promise<ClaudeSlashCommandDiscoveryResult> {
  const refresh = options.refresh === true
  try {
    const outcome = await targetScans.run(
      scanKey(target, repos, options.providerRootOverrides),
      { ttlMs: target.kind === 'wsl' ? WSL_RESULT_TTL_MS : 0, refresh },
      async () => {
        if (target.kind === 'wsl') {
          return discoverClaudeSlashCommandsInWsl({
            distro: target.distro,
            homeDir: target.homeDir,
            cwd: target.cwd,
            providerRootOverrides: options.providerRootOverrides
          })
        }
        return target.cwd
          ? discoverClaudeSlashCommands({
              repos: [],
              cwd: target.cwd,
              refresh,
              providerRootOverrides: options.providerRootOverrides
            })
          : discoverClaudeSlashCommands({
              repos: [...repos],
              refresh,
              providerRootOverrides: options.providerRootOverrides
            })
      }
    )
    return outcome.value
  } catch (error) {
    if (!isSkillRootUnavailableError(error)) {
      throw error
    }
    throw new Error('Claude command discovery is still reading a slow location. Try again.', {
      cause: error
    })
  }
}

export function resolveClaudeSlashCommandDiscoveryTarget(
  target: SkillDiscoveryTarget | undefined
): ResolvedSkillDiscoveryTarget {
  return resolveSkillDiscoveryTarget(target)
}
