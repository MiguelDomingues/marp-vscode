import { unlink, writeFile } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { promisify } from 'util'
import { Options } from 'markdown-it'
import nanoid from 'nanoid'
import { TextDocument, Uri, workspace } from 'vscode'
import { MarpOptions } from '@marp-team/marp-core'
import themes, { ThemeType } from './themes'
import { marpConfiguration } from './utils'

export interface WorkFile {
  path: string
  cleanup: () => Promise<void>
}

let cachedPreviewOption: MarpOptions | undefined

const breaks = (inheritedValue: boolean): boolean => {
  switch (marpConfiguration().get<string>('breaks')) {
    case 'off':
      return false
    case 'inherit':
      return inheritedValue
    default:
      return true
  }
}

export const marpCoreOptionForPreview = (
  baseOption: Options & MarpOptions
): MarpOptions => {
  if (!cachedPreviewOption) {
    cachedPreviewOption = {
      container: { tag: 'div', id: 'marp-vscode' },
      html: marpConfiguration().get<boolean>('enableHtml') || undefined,
      extensionAttrs:
        marpConfiguration().get<boolean>('enableExtensionAttrs') || undefined,
      markdown: { breaks: breaks(!!baseOption.breaks) },
      minifyCSS: false,
      script: false,
    }
  }
  return cachedPreviewOption
}

export const marpCoreOptionForCLI = async ({ uri }: TextDocument) => {
  const baseOpts = {
    allowLocalFiles: true,
    html: marpConfiguration().get<boolean>('enableHtml') || undefined,
    extensionAttrs:
      marpConfiguration().get<boolean>('enableExtensionAttrs') || undefined,
    options: {
      markdown: {
        breaks: breaks(
          !!workspace
            .getConfiguration('markdown.preview', uri)
            .get<boolean>('breaks')
        ),
      },
    },
    themeSet: [] as string[],
    vscode: {} as Record<string, any>,
  }

  const workspaceFolder = workspace.getWorkspaceFolder(uri)
  const parentFolder = uri.scheme === 'file' && path.dirname(uri.fsPath)
  const baseFolder = workspaceFolder ? workspaceFolder.uri.fsPath : parentFolder

  const themeFiles: WorkFile[] = (
    await Promise.all(
      themes
        .loadStyles(baseFolder ? Uri.parse(`file:${baseFolder}`) : undefined)
        .map(promise =>
          promise.then(
            async theme => {
              if (theme.type === ThemeType.File) {
                return { path: theme.path, cleanup: () => Promise.resolve() }
              }

              if (theme.type === ThemeType.Remote) {
                const cssName = `.marp-vscode-cli-theme-${nanoid()}.css`
                const tmp = path.join(tmpdir(), cssName)

                await promisify(writeFile)(tmp, theme.css)
                return { path: tmp, cleanup: () => promisify(unlink)(tmp) }
              }
            },
            e => console.error(e)
          )
        )
    )
  ).filter((w): w is WorkFile => !!w)

  baseOpts.themeSet = themeFiles.map(w => w.path)
  baseOpts.vscode.themeFiles = themeFiles

  return baseOpts
}

export const clearMarpCoreOptionCache = () => {
  cachedPreviewOption = undefined
}
