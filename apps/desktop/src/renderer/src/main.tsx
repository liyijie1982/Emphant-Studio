import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, App as AntApp } from 'antd'
import { Provider } from 'react-redux'
import { BrowserRouter } from 'react-router-dom'
import './lib/desktopApi'
import { enableWorkspacePersistence, store } from './store'
import { loadWorkbenchSnapshot } from './lib/workbenchDb'
import { AppRouter } from './router/AppRouter'
import {
  hydrateWorkbench,
  hydrateWorkspaceContent,
  hydrateWorkspacePreferences,
  updateSettings,
  updateProviderConfig
} from './store/workbenchSlice'
import './styles/global.css'

const bootstrap = async () => {
  const snapshot = await loadWorkbenchSnapshot()
  if (snapshot) {
    if (snapshot.settings.restoreWorkspaceOnLaunch) {
      store.dispatch(hydrateWorkbench(snapshot))
    } else {
      store.dispatch(
        hydrateWorkspacePreferences({
          settings: snapshot.settings,
          providers: snapshot.providers,
          mcpTools: snapshot.mcpTools,
          mcpServers: snapshot.mcpServers
        })
      )
    }
  }

  const configuredDirectory = store.getState().workbench.settings.defaultWorkingDirectory
  const workspaceDirectory =
    configuredDirectory || (await window.emphant.getDefaultWorkspaceDirectory())
  if (configuredDirectory !== workspaceDirectory) {
    store.dispatch(updateSettings({ defaultWorkingDirectory: workspaceDirectory }))
  }

  const workspaceContent = await window.emphant.loadWorkspaceContent(workspaceDirectory)
  if (workspaceContent) {
    store.dispatch(hydrateWorkspaceContent(workspaceContent))
  }
  enableWorkspacePersistence()
  await window.emphant.saveWorkspaceContent(workspaceDirectory, {
    systemNotes: store.getState().workbench.systemNotes,
    knowledgeBases: store.getState().workbench.knowledgeBases,
    files: store.getState().workbench.files,
    topics: store.getState().workbench.topics,
    messages: store.getState().workbench.messages,
    todoGroups: store.getState().workbench.todoGroups,
    todoItems: store.getState().workbench.todoItems
  })

  if (window.emphant?.hasCredential) {
    for (const provider of store.getState().workbench.providers) {
      const credentialConfigured = await window.emphant.hasCredential({
        scope: 'provider',
        id: provider.id
      })
      store.dispatch(
        updateProviderConfig({
          providerId: provider.id,
          patch: { credentialConfigured }
        })
      )
    }
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Provider store={store}>
        <ConfigProvider
          theme={{
            token: {
              colorPrimary: '#8cb4ff',
              colorBgBase: '#0f1115',
              colorTextBase: '#edf2ff',
              colorBorder: 'rgba(173, 197, 255, 0.36)',
              colorBorderSecondary: 'rgba(173, 197, 255, 0.24)',
              controlOutline: 'rgba(140, 180, 255, 0.22)',
              colorBgElevated: '#151a24',
              colorBgSpotlight: '#151a24',
              colorTextLightSolid: '#edf2ff',
              boxShadowSecondary: '0 12px 32px rgba(0, 0, 0, 0.38)',
              borderRadius: 18,
              fontFamily:
                '"SF Pro Display", "SF Pro Text", "PingFang SC", sans-serif'
            }
          }}
        >
          <AntApp>
            <BrowserRouter>
              <AppRouter />
            </BrowserRouter>
          </AntApp>
        </ConfigProvider>
      </Provider>
    </React.StrictMode>
  )
}

void bootstrap()
