import type { WorkbenchState } from '@emphant/shared/types'

const STORAGE_KEY = 'emphant-studio:workbench'

export const loadWorkbenchSnapshot = async (): Promise<WorkbenchState | null> => {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return null
    }

    const snapshot = JSON.parse(raw) as WorkbenchState
    const legacyProviders = snapshot.providers as Array<
      WorkbenchState['providers'][number] & { apiKey?: string }
    >

    for (const provider of legacyProviders) {
      if (provider.apiKey) {
        await window.emphant.setCredential({
          scope: 'provider',
          id: provider.id,
          secret: provider.apiKey
        })
        provider.credentialConfigured = true
        delete provider.apiKey
      } else {
        provider.credentialConfigured = await window.emphant.hasCredential({
          scope: 'provider',
          id: provider.id
        })
      }
    }

    snapshot.mcpServers = snapshot.mcpServers ?? []
    for (const server of snapshot.mcpServers) {
      server.credentialConfigured = await window.emphant.hasCredential({
        scope: 'mcp',
        id: server.id
      })
    }
    return snapshot
  } catch {
    return null
  }
}

export const saveWorkbenchSnapshot = async (state: WorkbenchState) => {
  const knowledgeFileIds = new Set(
    state.knowledgeBases.flatMap((base) => base.sourceFileIds)
  )
  const sanitized = {
    ...state,
    systemNotes: [],
    knowledgeBases: [],
    files: state.files.filter((file) => !knowledgeFileIds.has(file.id)),
    providers: state.providers.map(({ ...provider }) => provider),
    mcpServers: state.mcpServers.map(({ ...server }) => server)
  }
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized))
}

export const clearWorkbenchSnapshot = async () => {
  window.localStorage.removeItem(STORAGE_KEY)
}
