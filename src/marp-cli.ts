import { unlink, writeFile } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import { nanoid } from 'nanoid'
import { TextDocument, workspace } from 'vscode'
import { WorkFile, marpCoreOptionForCLI } from './option'
import { marpConfiguration } from './utils'

const promiseWriteFile = promisify(writeFile)
const promiseUnlink = promisify(unlink)

export class MarpCLIError extends Error {}

export async function createWorkFile(doc: TextDocument): Promise<WorkFile> {
  // Use a real file if posibble
  if (doc.uri.scheme === 'file' && !doc.isDirty) {
    return { path: doc.uri.fsPath, cleanup: () => Promise.resolve() }
  }

  const text = doc.getText()
  const tmpFileName = `.marp-vscode-tmp-${nanoid()}`
  const createCleanup = (target: string) => () => promiseUnlink(target)

  // Try to create tmp file to the same directory as a document
  const sameDirTmpPath = path.join(path.dirname(doc.uri.fsPath), tmpFileName)

  try {
    await promiseWriteFile(sameDirTmpPath, text)
    return { path: sameDirTmpPath, cleanup: createCleanup(sameDirTmpPath) }
  } catch (e) {
    // no ops
  }

  // If it fails, try to create to the root of workspace
  const documentWorkspace = workspace.getWorkspaceFolder(doc.uri)

  if (documentWorkspace?.uri.scheme === 'file') {
    const workspaceDir = documentWorkspace.uri.fsPath
    const workspaceDirTmpPath = path.join(workspaceDir, tmpFileName)

    try {
      await promiseWriteFile(workspaceDirTmpPath, text)
      return {
        path: workspaceDirTmpPath,
        cleanup: createCleanup(workspaceDirTmpPath),
      }
    } catch (e) {
      // no ops
    }
  }

  // If it fails, create to OS specific tmp directory
  const tmpPath = path.join(tmpdir(), tmpFileName)

  await promiseWriteFile(tmpPath, text)
  return { path: tmpPath, cleanup: createCleanup(tmpPath) }
}

export async function createConfigFile(
  target: TextDocument
): Promise<WorkFile> {
  const tmpFileName = `.marp-vscode-cli-conf-${nanoid()}.json`
  const tmpPath = path.join(tmpdir(), tmpFileName)
  const cliOpts = await marpCoreOptionForCLI(target)

  await promiseWriteFile(tmpPath, JSON.stringify(cliOpts))

  return {
    path: tmpPath,
    cleanup: async () => {
      await Promise.all([
        promiseUnlink(tmpPath),
        ...cliOpts.vscode.themeFiles.map((w: WorkFile) => w.cleanup()),
      ])
    },
  }
}

export default async function runMarpCli(...argv: string[]): Promise<void> {
  console.info(`Execute Marp CLI: ${argv.join(' ')}`)

  const { marpCli, CLIError, CLIErrorCode } = await import(
    '@marp-team/marp-cli'
  )
  const { CHROME_PATH } = process.env

  let exitCode: number

  try {
    process.env.CHROME_PATH =
      marpConfiguration().get<string>('chromePath') || CHROME_PATH

    exitCode = await marpCli(argv)
  } catch (e) {
    console.error(e)

    if (
      e instanceof CLIError &&
      e.errorCode === CLIErrorCode.NOT_FOUND_CHROMIUM
    ) {
      const chromium =
        process.platform === 'linux'
          ? ' or [Chromium](https://www.chromium.org/)'
          : ''

      throw new MarpCLIError(
        `It requires to install [Google Chrome](https://www.google.com/chrome/)${chromium} for exporting.`
      )
    }

    throw e
  } finally {
    process.env.CHROME_PATH = CHROME_PATH
  }

  if (exitCode !== 0) {
    throw new MarpCLIError(
      `Marp CLI throwed unexpected error with exit code ${exitCode}.`
    )
  }
}
