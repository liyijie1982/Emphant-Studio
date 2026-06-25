import { Navigate, Route, Routes } from 'react-router-dom'
import { AgentsPage } from '@/pages/agents'
import { AppShell } from '@/shell/AppShell'
import { HomePage } from '@/pages/home/HomePage'
import { FilesPage } from '@/pages/files/FilesPage'
import { KnowledgePage } from '@/pages/knowledge/KnowledgePage'
import { NotesPage } from '@/pages/notes/NotesPage'
import { ProfilePage, ProfileSettingsPage } from '@/pages/profile'
import { SettingsPage } from '@/pages/settings/SettingsPage'
import { SkillsPage } from '@/pages/skills/SkillsPage'
import { TodoPage } from '@/pages/todo/TodoPage'

export const AppRouter = () => (
  <Routes>
    <Route element={<AppShell />}>
      <Route index element={<HomePage />} />
      <Route path="/agents" element={<AgentsPage />} />
      <Route path="/files" element={<FilesPage />} />
      <Route path="/skills" element={<SkillsPage />} />
      <Route path="/knowledge" element={<KnowledgePage />} />
      <Route path="/notes" element={<NotesPage />} />
      <Route path="/profile" element={<ProfilePage />} />
      <Route path="/profile/settings" element={<ProfileSettingsPage />} />
      <Route path="/todo" element={<TodoPage />} />
      <Route path="/settings" element={<SettingsPage />} />
      <Route path="*" element={<Navigate replace to="/" />} />
    </Route>
  </Routes>
)
