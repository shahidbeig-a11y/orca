import { open, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { relative, sep } from 'node:path'
import { summarizeSkillMarkdown } from '../../shared/skill-metadata'
import type { ClaudeSlashCommandDiscoveryResult, DiscoveredClaudeSlashCommand } from '../../shared/claude-slash-command-discovery'
import type { Repo } from '../../shared/repo-types'
import {
  buildClaudeCommandDiscoverySources,
  claudeCommandNameFromRelativePath
} from './claude-command-discovery-sources'
import {
  discoverClaudePluginCommandSources as discoverNativeClaudePluginCommandSources
} from './claude-plugin-skill-sources'
import { findCommandMarkdownFiles } from './claude-command-file-walk'
import { runSkillCandidateTasks } from './skill-candidate-concurrency'
import { isSkillRootUnavailableError, SkillScanCoalescer } from './skill-scan-coalescer'
import type { SkillProviderRootOverrides } from './skill-provider-destinations'
import { skillDirectoryMaxDepth } from '../../shared/skill-discovery-depth'
import { sourceLabelForSkill, type SkillScanRoot } from './skill-discovery-sources'

const MAX_MARKDOWN_BYTES = 256 * 1024
const COMMAND_ROOT_SCAN_TTL_MS = 10_000
const MAX_CACHED_COMMAND_ROOTS = 256

type RootScan = { exists: boolean; commands: DiscoveredClaudeSlashCommand[]; unavailable?: boolean }
type ScannedCommand = DiscoveredClaudeSlashCommand & { canonicalCommandFilePath: string }

const rootScans = new SkillScanCoalescer<RootScan>(MAX_CACHED_COMMAND_ROOTS)

export function clearClaudeCommandRootScanCache(): void {
  rootScans.clear()
}

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await stat(pathValue)
    return true
  } catch {
    return false
  }
}

async function readCommandSummary(commandFilePath: string): Promise<{
  description: string | null
} | null> {
  try {
    const fileStat = await stat(commandFilePath)
    const file = await open(commandFilePath, 'r')
    let content = ''
    try {
      const buffer = Buffer.alloc(Math.min(fileStat.size, MAX_MARKDOWN_BYTES))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      content = buffer.toString('utf8', 0, bytesRead)
    } finally {
      await file.close()
    }
    const summary = summarizeSkillMarkdown(content)
    return { description: summary.description }
  } catch {
    return null
  }
}

async function scanRoot(root: SkillScanRoot, signal: AbortSignal): Promise<ScannedCommand[]> {
  const maxDepth = skillDirectoryMaxDepth(root.sourceKind)
  const commandFiles = await findCommandMarkdownFiles(root.path, maxDepth, signal)
  const commands = await runSkillCandidateTasks(
    commandFiles.map((commandFilePath) => async (): Promise<ScannedCommand | null> => {
      signal.throwIfAborted()
      const relPath = relative(root.path, commandFilePath)
      const name = claudeCommandNameFromRelativePath(relPath, sep)
      if (!name) {
        return null
      }
      const summary = await readCommandSummary(commandFilePath)
      if (!summary) {
        return null
      }
      return {
        name,
        description: summary.description,
        commandFilePath,
        sourceKind: root.sourceKind,
        sourceLabel: sourceLabelForSkill(root, root.sourceKind),
        canonicalCommandFilePath: commandFilePath
      }
    })
  )
  return commands.filter((command): command is ScannedCommand => command !== null)
}

function rootScanKey(root: SkillScanRoot): string {
  return `${root.sourceKind}\0${root.path}`
}

async function scanRootShared(root: SkillScanRoot, refresh: boolean): Promise<RootScan> {
  const key = rootScanKey(root)
  try {
    const outcome = await rootScans.run(
      key,
      { ttlMs: COMMAND_ROOT_SCAN_TTL_MS, refresh },
      async (signal) => {
        const exists = await pathExists(root.path)
        if (!exists) {
          return { exists: false, commands: [] }
        }
        const scanned = await scanRoot(root, signal)
        return {
          exists: true,
          commands: scanned.map(({ canonicalCommandFilePath: _canonical, ...command }) => command)
        }
      }
    )
    return outcome.value
  } catch (error) {
    if (!isSkillRootUnavailableError(error)) {
      throw error
    }
    return { exists: true, commands: [], unavailable: true }
  }
}

function mergeScannedCommand(
  seen: Map<string, DiscoveredClaudeSlashCommand>,
  command: DiscoveredClaudeSlashCommand
): void {
  const existing = seen.get(command.commandFilePath)
  if (!existing) {
    seen.set(command.commandFilePath, command)
    return
  }
  if (!existing.description && command.description) {
    existing.description = command.description
  }
}

function compareCommands(a: DiscoveredClaudeSlashCommand, b: DiscoveredClaudeSlashCommand): number {
  return (
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
    a.sourceLabel.localeCompare(b.sourceLabel, undefined, { sensitivity: 'base' }) ||
    a.commandFilePath.localeCompare(b.commandFilePath)
  )
}

export async function discoverClaudeSlashCommands(args: {
  repos?: Repo[]
  homeDir?: string
  cwd?: string
  includeCwd?: boolean
  providerRootOverrides?: SkillProviderRootOverrides
  refresh?: boolean
}): Promise<ClaudeSlashCommandDiscoveryResult> {
  const homeDir = args.homeDir ?? homedir()
  const refresh = args.refresh === true
  const roots = [
    ...buildClaudeCommandDiscoverySources({ ...args, homeDir }),
    ...(args.cwd && args.includeCwd !== false
      ? await discoverNativeClaudePluginCommandSources({ homeDir, cwd: args.cwd })
      : [])
  ]
  const scans = await Promise.all(roots.map((root) => scanRootShared(root, refresh)))
  const seen = new Map<string, DiscoveredClaudeSlashCommand>()
  for (const scan of scans) {
    if (scan.unavailable) {
      continue
    }
    for (const command of scan.commands) {
      mergeScannedCommand(seen, command)
    }
  }
  const commands = Array.from(seen.values()).sort(compareCommands)
  return { commands, scannedAt: Date.now() }
}

export { buildClaudeCommandDiscoverySources } from './claude-command-discovery-sources'
