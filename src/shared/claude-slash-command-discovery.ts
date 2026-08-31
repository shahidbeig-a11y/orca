import { z } from 'zod'
import type { SlashCommandSuggestion } from './native-chat-slash-commands'
import type { SkillSourceKind } from './skills'
import { SkillDiscoveryTargetSchema, type SkillDiscoveryTarget } from './skills'

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
