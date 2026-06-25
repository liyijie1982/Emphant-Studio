import {
  AppstoreOutlined,
  CheckSquareOutlined,
  DatabaseOutlined,
  HomeOutlined,
  RobotOutlined,
  SettingOutlined,
  SnippetsOutlined
} from '@ant-design/icons'
import { Layout, Space, Typography } from 'antd'
import { useEffect, useRef } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { AppNavbar } from './AppNavbar'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  addMailCheckErrorNotification,
  applyMailCheckResult,
  runTodoTask,
  selectActiveTodoTaskId,
  selectMailAgentSettings,
  selectTodoItems,
  updateMailAgentSettings
} from '@/store/workbenchSlice'

const navigationItems = [
  { to: '/', icon: <HomeOutlined />, label: '工作台' },
  { to: '/agents', icon: <RobotOutlined />, label: 'Agent' },
  { to: '/skills', icon: <AppstoreOutlined />, label: 'Skills' },
  { to: '/knowledge', icon: <DatabaseOutlined />, label: '知识库' },
  { to: '/notes', icon: <SnippetsOutlined />, label: '笔记' },
  { to: '/todo', icon: <CheckSquareOutlined />, label: 'TODO' },
  { to: '/settings', icon: <SettingOutlined />, label: '设置' }
]

export const AppShell = () => {
  const dispatch = useAppDispatch()
  const mailAgentSettings = useAppSelector(selectMailAgentSettings)
  const todoItems = useAppSelector(selectTodoItems)
  const activeTodoTaskId = useAppSelector(selectActiveTodoTaskId)
  const location = useLocation()
  const contentRef = useRef<HTMLElement | null>(null)
  const scheduledTodoRunIdsRef = useRef(new Set<string>())

  useEffect(() => {
    const node = contentRef.current
    if (!node) {
      return
    }

    const resetScroll = () => {
      node.scrollTo({ top: 0, left: 0, behavior: 'auto' })
    }

    resetScroll()
    const frameId = window.requestAnimationFrame(resetScroll)

    return () => window.cancelAnimationFrame(frameId)
  }, [location.pathname])

  useEffect(() => {
    if (!mailAgentSettings.enabled) return

    let checking = false
    const checkAllAccounts = async () => {
      if (checking) return
      checking = true
      try {
        const profile = await window.emphant.getMemoryProfile()
        const configuredEmails = profile.emails.filter((email) => email.credentialConfigured)
        if (
          configuredEmails.length > 0 &&
          !configuredEmails.some((email) => email.address === mailAgentSettings.accountEmail)
        ) {
          dispatch(updateMailAgentSettings({ accountEmail: configuredEmails[0].address }))
        }
        dispatch(applyMailCheckResult(await window.emphant.checkAllEmailAccounts()))
      } catch (error) {
        console.error('Failed to check email accounts', error)
        dispatch(
          addMailCheckErrorNotification({
            message: error instanceof Error ? error.message : '邮件检查失败'
          })
        )
      } finally {
        checking = false
      }
    }

    void checkAllAccounts()
    const intervalMs = Math.max(mailAgentSettings.checkIntervalMinutes, 1) * 60_000
    const timerId = window.setInterval(() => {
      void checkAllAccounts()
    }, intervalMs)

    return () => window.clearInterval(timerId)
  }, [
    dispatch,
    mailAgentSettings.accountEmail,
    mailAgentSettings.checkIntervalMinutes,
    mailAgentSettings.enabled
  ])

  useEffect(() => {
    const runDueTodo = () => {
      if (activeTodoTaskId) {
        return
      }
      const dueTodo = todoItems.find((item) => {
        if (!item.scheduledAt || item.status !== 'scheduled') {
          return false
        }
        if (scheduledTodoRunIdsRef.current.has(item.id)) {
          return false
        }
        return Date.parse(item.scheduledAt) <= Date.now()
      })
      if (!dueTodo) {
        return
      }
      scheduledTodoRunIdsRef.current.add(dueTodo.id)
      void dispatch(runTodoTask(dueTodo.id))
        .unwrap()
        .catch((error) => {
          console.error('Failed to run scheduled TODO', error)
        })
        .finally(() => {
          scheduledTodoRunIdsRef.current.delete(dueTodo.id)
        })
    }

    runDueTodo()
    const timerId = window.setInterval(runDueTodo, 15_000)
    return () => window.clearInterval(timerId)
  }, [activeTodoTaskId, dispatch, todoItems])

  return (
    <Layout className="app-shell">
      <aside className="app-sidebar">
        <Space direction="vertical" size={14} className="app-nav">
          {navigationItems.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                isActive ? 'app-nav__item is-active' : 'app-nav__item'
              }
            >
              <span className="app-nav__icon">{item.icon}</span>
              <span className="app-nav__label">{item.label}</span>
            </NavLink>
          ))}
        </Space>
        <div className="sidebar-footer">
          <Typography.Text type="secondary">P0 Build</Typography.Text>
        </div>
      </aside>
      <Layout className="app-main">
        <AppNavbar />
        <main
          ref={contentRef}
          className={location.pathname === '/' ? 'app-content app-content--workbench' : 'app-content'}
        >
          <Outlet />
        </main>
      </Layout>
    </Layout>
  )
}
