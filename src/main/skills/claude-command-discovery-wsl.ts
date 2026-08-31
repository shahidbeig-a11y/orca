import { posix as pathPosix } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import {
  collapseDiscoveredCommandsByName,
  type ClaudeSlashCommandDiscoveryResult,
  type DiscoveredClaudeSlashCommand
} from '../../shared/claude-slash-command-discovery'
import { quoteBashString } from '../wsl-bash-command'
import { runWslProcess } from '../wsl/wsl-runner'
import {
  buildClaudeCommandDiscoverySources,
  claudeCommandNameFromRelativePath
} from './claude-command-discovery-sources'
import { discoverClaudePluginCommandSourcesInWsl } from './claude-plugin-skill-sources-wsl'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { SKILL_STAGING_GLOB } from './skill-delete/staging-names'
import { skillFileMaxDepth } from '../../shared/skill-discovery-depth'
import { sourceLabelForSkill, type SkillScanRoot } from './skill-discovery-sources'

const MAX_MARKDOWN_BYTES = 256 * 1024
const WSL_SCAN_TIMEOUT_MS = 10_000
const WSL_SCAN_MAX_OUTPUT_BYTES = 128 * 1024 * 1024

export function buildWslClaudeCommandDiscoveryCommand(roots: readonly SkillScanRoot[]): string {
  const lines = [
    'set -u',
    'set -o pipefail',
    'scan_root() {',
    '  root_index=$1',
    '  root_path=$2',
    '  max_depth=$3',
    '  if [ ! -d "$root_path" ]; then',
    `    printf '%s\\0%s\\0%s\\0' R "$root_index" 0`,
    '    return',
    '  fi',
    `  printf '%s\\0%s\\0%s\\0' R "$root_index" 1`,
    `  while IFS= read -r -d '' command_file; do`,
    `    updated_at=$(stat -c '%Y' -- "$command_file" 2>/dev/null || true)`,
    `    encoded_markdown=$(head -c ${MAX_MARKDOWN_BYTES} -- "$command_file" 2>/dev/null | base64 | tr -d '\\n') || continue`,
    `    printf '%s\\0%s\\0%s\\0%s\\0' C "$root_index" "$command_file" "$updated_at"`,
    `    printf '%s' "$encoded_markdown"`,
    `    printf '\\0'`,
    `  done < <(find -L "$root_path" -mindepth 1 -maxdepth "$max_depth" \\( -name '${SKILL_STAGING_GLOB}' -prune \\) -o \\( -type f -name '*.md' -print0 \\) 2>/dev/null)`,
    '}'
  ]
  roots.forEach((root, index) => {
    const maxDepth = skillFileMaxDepth(root.sourceKind)
    lines.push(`scan_root ${index} ${quoteBashString(root.path)} ${maxDepth}`)
  })
  return lines.join('\n')
}

async function executeWslCommandDiscovery(distro: string, script: string): Promise<string> {
  const result = await runWslProcess({
    distro,
    loginPath: 'none',
    script,
    shell: 'bash',
    timeoutMs: WSL_SCAN_TIMEOUT_MS,
    maxOutputBytes: WSL_SCAN_MAX_OUTPUT_BYTES
  })
  if (result.code !== 0 || result.timedOut) {
    throw new Error('claude-command-discovery-wsl-scan-failed')
  }
  return result.stdout
}

function readProtocolField(fields: string[], index: number): string {
  const value = fields[index]
  if (value === undefined) {
    throw new Error('WSL Claude command discovery returned an incomplete response.')
  }
  return value
}

export function parseWslClaudeCommandDiscoveryOutput(
  output: string,
  roots: readonly SkillScanRoot[],
  scannedAt = Date.now()
): ClaudeSlashCommandDiscoveryResult {
  const fields = output.split('\0')
  const rootExists = new Map<number, boolean>()
  const commandsByPath = new Map<string, DiscoveredClaudeSlashCommand>()
  let index = 0
  while (index < fields.length && fields[index]) {
    const recordKind = fields[index++]
    if (recordKind === 'R') {
      const rootIndex = Number.parseInt(readProtocolField(fields, index++), 10)
      rootExists.set(rootIndex, readProtocolField(fields, index++) === '1')
      continue
    }
    if (recordKind !== 'C') {
      throw new Error('WSL Claude command discovery returned an invalid response.')
    }
    const rootIndex = Number.parseInt(readProtocolField(fields, index++), 10)
    const root = roots[rootIndex]
    if (!root) {
      throw new Error('WSL Claude command discovery referenced an unknown root.')
    }
    const commandFilePath = readProtocolField(fields, index++)
    readProtocolField(fields, index++) // updated_at seconds
    const encodedMarkdown = readProtocolField(fields, index++)
    const relPath = pathPosix.relative(root.path, commandFilePath)
    const name = claudeCommandNameFromRelativePath(relPath, pathPosix.sep)
    if (!name) {
      continue
    }
    const markdown = Buffer.from(encodedMarkdown, 'base64').toString('utf8')
    const summary = summarizeSkillMarkdown(markdown)
    const command: DiscoveredClaudeSlashCommand = {
      name,
      description: summary.description,
      commandFilePath,
      sourceKind: root.sourceKind,
      sourceLabel: sourceLabelForSkill(root, root.sourceKind)
    }
    if (!commandsByPath.has(commandFilePath)) {
      commandsByPath.set(commandFilePath, command)
    }
  }
  for (const [rootIndex, exists] of rootExists.entries()) {
    if (!exists) {
      continue
    }
    const root = roots[rootIndex]
    if (!root) {
      throw new Error('WSL Claude command discovery referenced an unknown root.')
    }
  }
  const commands = collapseDiscoveredCommandsByName([...commandsByPath.values()]).sort(
    (left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: 'base' })
  )
  return { commands, scannedAt }
}

export async function discoverClaudeSlashCommandsInWsl(args: {
  distro: string
  homeDir: string
  cwd: string
  providerRootOverrides?: SkillProviderRootOverrides
}): Promise<ClaudeSlashCommandDiscoveryResult> {
  const pluginRoots = await discoverClaudePluginCommandSourcesInWsl(args)
  const roots = [
    ...buildClaudeCommandDiscoverySources({
      homeDir: args.homeDir,
      cwd: args.cwd,
      repos: [],
      includeCwd: true,
      pathApi: pathPosix,
      providerRootOverrides: args.providerRootOverrides
    }),
    ...pluginRoots
  ]
  const output = await executeWslCommandDiscovery(
    args.distro,
    buildWslClaudeCommandDiscoveryCommand(roots)
  )
  return parseWslClaudeCommandDiscoveryOutput(output, roots)
}
