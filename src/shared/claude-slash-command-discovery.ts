import type { z } from 'zod'
import type { SlashCommandSuggestion } from './native-chat-slash-commands'
import type { SkillSourceKind } from './skills'
import { SkillDiscoveryTargetSchema, type SkillDiscoveryTarget } from './skills'

const COMMAND_SOURCE_PRECEDENCE: Record<SkillSourceKind, number> = {
  repo: 0,
  home: 1,
  bundled: 2,
  plugin: 3
}

export type DiscoveredClaudeSlashCommand = {
  name: string
  description: string | null
  commandFilePath: string
  sourceKind: SkillSourceKind
  sourceLabel: string
}

export type ClaudeSlashCommandDiscoveryResult = {
  commands: DiscoveredClaudeSlashCommand[]
  scannedAt: number
}

export const ClaudeSlashCommandDiscoveryTargetSchema: z.ZodType<SkillDiscoveryTarget> =
  SkillDiscoveryTargetSchema

export function collapseDiscoveredCommandsByName(
  commands: readonly DiscoveredClaudeSlashCommand[]
): DiscoveredClaudeSlashCommand[] {
  const byName = new Map<string, DiscoveredClaudeSlashCommand>()
  for (const command of commands) {
    const existing = byName.get(command.name)
    if (!existing) {
      byName.set(command.name, command)
      continue
    }
    if (existing.commandFilePath === command.commandFilePath) {
      if (!existing.description && command.description) {
        existing.description = command.description
      }
      continue
    }
    const incomingRank = COMMAND_SOURCE_PRECEDENCE[command.sourceKind]
    const existingRank = COMMAND_SOURCE_PRECEDENCE[existing.sourceKind]
    if (
      incomingRank < existingRank ||
      (incomingRank === existingRank &&
        command.commandFilePath.localeCompare(existing.commandFilePath) > 0)
    ) {
      byName.set(command.name, command)
    }
  }
  return [...byName.values()]
}

export function toSlashCommandSuggestions(
  commands: readonly DiscoveredClaudeSlashCommand[]
): SlashCommandSuggestion[] {
  return commands.map((command) => ({
    name: command.name,
    ...(command.description ? { description: command.description } : {})
  }))
}

export function mergeVerifiedAndDiscoveredSlashCommands(
  verified: readonly SlashCommandSuggestion[],
  discovered: readonly SlashCommandSuggestion[]
): readonly SlashCommandSuggestion[] {
  const seen = new Set(verified.map((command) => command.name))
  const extra = discovered.filter((command) => !seen.has(command.name))
  if (extra.length === 0) {
    return verified
  }
  return [...verified, ...extra]
}
