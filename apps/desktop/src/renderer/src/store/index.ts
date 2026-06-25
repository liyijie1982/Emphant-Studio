import { configureStore } from '@reduxjs/toolkit'
import { saveWorkbenchSnapshot } from '@/lib/workbenchDb'
import { workbenchReducer } from './workbenchSlice'

export const store = configureStore({
  reducer: {
    workbench: workbenchReducer
  }
})

let saveTimer: number | undefined
let workspacePersistenceEnabled = false
let workspaceSaveQueue = Promise.resolve()

export const enableWorkspacePersistence = () => {
  workspacePersistenceEnabled = true
}

export const saveWorkspaceContentNow = () => {
  const state = store.getState().workbench
  if (!state.settings.defaultWorkingDirectory) {
    return Promise.reject(new Error('工作目录尚未设置。'))
  }
  const snapshot = {
    systemNotes: state.systemNotes,
    knowledgeBases: state.knowledgeBases,
    files: state.files,
    topics: state.topics,
    messages: state.messages,
    todoGroups: state.todoGroups,
    todoItems: state.todoItems
  }
  const save = workspaceSaveQueue.then(() =>
    window.emphant.saveWorkspaceContent(
      state.settings.defaultWorkingDirectory,
      snapshot
    )
  )
  workspaceSaveQueue = save.catch((error) => {
    console.error('Failed to save workspace content', error)
  })
  return save
}

store.subscribe(() => {
  window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => {
    const state = store.getState().workbench
    void saveWorkbenchSnapshot(state)
    if (workspacePersistenceEnabled && state.settings.defaultWorkingDirectory) {
      void saveWorkspaceContentNow()
    }
  }, 250)
})

export type RootState = ReturnType<typeof store.getState>
export type AppDispatch = typeof store.dispatch
