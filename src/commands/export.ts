import path from 'path'
import {
  env,
  ProgressLocation,
  TextDocument,
  Uri,
  window,
  workspace,
} from 'vscode'
import marpCli, {
  createConfigFile,
  createWorkFile,
  MarpCLIError,
} from '../marp-cli'
import { marpConfiguration } from '../utils'
import {
  createWorkspaceProxyServer,
  WorkspaceProxyServer,
} from '../workspace-proxy-server'

export enum Types {
  html = 'html',
  pdf = 'pdf',
  pptx = 'pptx',
  png = 'png',
  jpeg = 'jpeg',
}

const extensions = {
  [Types.html]: ['html'] as const,
  [Types.pdf]: ['pdf'] as const,
  [Types.pptx]: ['pptx'] as const,
  [Types.png]: ['png'] as const,
  [Types.jpeg]: ['jpg', 'jpeg'] as const,
}

const descriptions = {
  [Types.html]: 'HTML slide deck' as const,
  [Types.pdf]: 'PDF slide deck' as const,
  [Types.pptx]: 'PowerPoint document' as const,
  [Types.png]: 'PNG image (first slide only)' as const,
  [Types.jpeg]: 'JPEG image (first slide only)' as const,
}

export const ITEM_CONTINUE_TO_EXPORT = 'Continue to export...'

export const command = 'markdown.marp.export'

const chromiumRequiredExtensions = [
  ...extensions.pdf,
  ...extensions.pptx,
  ...extensions.png,
  ...extensions.jpeg,
] as string[]

export const doExport = async (uri: Uri, document: TextDocument) => {
  let proxyServer: WorkspaceProxyServer | undefined
  let baseUrl: string | undefined

  const shouldProvideWorkspaceProxyServer = (() => {
    const ext = path.extname(uri.path).replace(/^\./, '')

    if (chromiumRequiredExtensions.includes(ext)) {
      // VS Code's Markdown preview may show local resources placed at the
      // outside of workspace, and using the proxy server in that case may too
      // much prevent file accesses.
      //
      // So leave handling local files to Marp CLI if the current document was
      // assumed to use local file system.
      return !['file', 'untitled'].includes(document.uri.scheme)
    }

    return false
  })()

  if (shouldProvideWorkspaceProxyServer) {
    const workspaceFolder = workspace.getWorkspaceFolder(document.uri)

    if (workspaceFolder) {
      proxyServer = await createWorkspaceProxyServer(workspaceFolder)
      baseUrl = `http://127.0.0.1:${proxyServer.port}${document.uri.path}`

      console.debug(
        `Proxy server for the workspace ${workspaceFolder.name} has created (port: ${proxyServer.port})`
      )
    }
  }

  try {
    const input = await createWorkFile(document)

    try {
      // Run Marp CLI
      const conf = await createConfigFile(document, {
        allowLocalFiles: !proxyServer,
      })

      try {
        await marpCli(['-c', conf.path, input.path, '-o', uri.fsPath], {
          baseUrl,
        })
        env.openExternal(uri)
      } finally {
        conf.cleanup()
      }
    } catch (e) {
      window.showErrorMessage(
        `Failure to export${(() => {
          if (e instanceof MarpCLIError) return `. ${e.message}`
          if (e instanceof Error) return `: [${e.name}] ${e.message}`

          return `. ${e.toString()}`
        })()}`
      )
    } finally {
      input.cleanup()
    }
  } finally {
    proxyServer?.dispose()
  }
}

export const saveDialog = async (document: TextDocument) => {
  const { fsPath } = document.uri

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  const defaultType = marpConfiguration().get<string>('exportType')!
  const baseTypes = Object.keys(extensions)
  const types = [...new Set<string>([defaultType, ...baseTypes])]

  const saveURI = await window.showSaveDialog({
    defaultUri: Uri.file(fsPath.slice(0, -path.extname(fsPath).length)),
    filters: types.reduce((f, t) => {
      if (baseTypes.includes(t)) f[descriptions[t]] = extensions[t]
      return f
    }, {}),
    saveLabel: 'Export',
  })

  if (saveURI) {
    await window.withProgress(
      {
        location: ProgressLocation.Notification,
        title: `Exporting Marp slide deck to ${saveURI.path}...`,
      },
      () => doExport(saveURI, document)
    )
  }
}

export default async function exportCommand() {
  const activeEditor = window.activeTextEditor

  if (activeEditor) {
    if (activeEditor.document.languageId === 'markdown') {
      await saveDialog(activeEditor.document)
    } else {
      const acted = await window.showWarningMessage(
        'A current document is not Markdown document.',
        ITEM_CONTINUE_TO_EXPORT
      )

      if (acted === ITEM_CONTINUE_TO_EXPORT) {
        await saveDialog(activeEditor.document)
      }
    }
  }
}
