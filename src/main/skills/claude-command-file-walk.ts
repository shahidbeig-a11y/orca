import type { Dirent } from 'node:fs'
import { readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { isSkillStagingEntryName } from './skill-delete/staging-names'

const COMMAND_FILE_SUFFIX = '.md'

function isWithinDepth(rootPath: string, childPath: string, maxDepth: number): boolean {
  const rel = relative(rootPath, childPath)
  if (!rel) {
    return true
  }
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return false
  }
  return rel.split(sep).length <= maxDepth
}

async function readEntries(dirPath: string): Promise<Dirent[] | null> {
  try {
    return await readdir(dirPath, { withFileTypes: true })
  } catch {
    return null
  }
}

function isCommandMarkdownFile(name: string): boolean {
  return name.length > COMMAND_FILE_SUFFIX.length && name.endsWith(COMMAND_FILE_SUFFIX)
}

export async function findCommandMarkdownFiles(
  rootPath: string,
  maxDepth: number,
  signal?: AbortSignal
): Promise<string[]> {
  const out: string[] = []
  const visitedDirectoryPaths = new Set<string>()
  async function visit(dirPath: string): Promise<void> {
    signal?.throwIfAborted()
    if (!isWithinDepth(rootPath, dirPath, maxDepth)) {
      return
    }
    let resolvedDirPath: string
    try {
      resolvedDirPath = await realpath(dirPath)
    } catch {
      return
    }
    if (visitedDirectoryPaths.has(resolvedDirPath)) {
      return
    }
    visitedDirectoryPaths.add(resolvedDirPath)

    const entries = await readEntries(dirPath)
    if (!entries) {
      return
    }
    for (const entry of entries) {
      signal?.throwIfAborted()
      if (isSkillStagingEntryName(entry.name)) {
        continue
      }
      const entryPath = join(dirPath, entry.name)
      if (isCommandMarkdownFile(entry.name)) {
        if (entry.isFile()) {
          out.push(entryPath)
          continue
        }
        if (entry.isSymbolicLink()) {
          try {
            if ((await stat(entryPath)).isFile()) {
              out.push(entryPath)
            }
          } catch {
            // Broken links are not valid command files.
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        await visit(entryPath)
        continue
      }
      if (entry.isSymbolicLink()) {
        let linksToDirectory = false
        try {
          linksToDirectory = (await stat(entryPath)).isDirectory()
        } catch {
          // Broken links are not valid command directories.
        }
        if (linksToDirectory) {
          await visit(entryPath)
        }
      }
    }
  }
  await visit(rootPath)
  return out
}
