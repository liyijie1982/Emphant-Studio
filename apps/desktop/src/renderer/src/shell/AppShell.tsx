import {
  AppstoreOutlined,
  CheckSquareOutlined,
  DatabaseOutlined,
  HomeOutlined,
  LockOutlined,
  RobotOutlined,
  SettingOutlined,
  SnippetsOutlined,
  UserOutlined
} from '@ant-design/icons'
import { App, Button, Checkbox, Form, Input, Layout, Space, Typography } from 'antd'
import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { AppNavbar } from './AppNavbar'
import { useBackgroundTaskManager } from './useBackgroundTaskManager'
import { useWindowDrag } from '@/hooks/useWindowDrag'

const navigationItems = [
  { to: '/', icon: <HomeOutlined />, label: '工作台' },
  { to: '/agents', icon: <RobotOutlined />, label: '智能体' },
  { to: '/skills', icon: <AppstoreOutlined />, label: '技能' },
  { to: '/knowledge', icon: <DatabaseOutlined />, label: '知识' },
  { to: '/notes', icon: <SnippetsOutlined />, label: '笔记' },
  { to: '/todo', icon: <CheckSquareOutlined />, label: '任务' },
  { to: '/settings', icon: <SettingOutlined />, label: '设置' }
]

const AUTH_PROFILE_KEY = 'emphant:auth-profile'
const AUTH_SESSION_KEY = 'emphant:auth-session'
const REMEMBER_LOGIN_MS = 7 * 24 * 60 * 60 * 1000

type AuthProfile = {
  username: string
}

type AuthSession = {
  username: string
  expiresAt: number
}

type LoginFormValues = {
  username: string
  password: string
  confirmPassword?: string
  remember?: boolean
}

const readAuthProfile = (): AuthProfile | null => {
  const rawProfile = window.localStorage.getItem(AUTH_PROFILE_KEY)
  if (!rawProfile) {
    return null
  }
  try {
    const profile = JSON.parse(rawProfile) as Partial<AuthProfile>
    if (typeof profile.username !== 'string') {
      return null
    }
    const sanitizedProfile = { username: profile.username }
    if ('passwordHash' in profile || 'salt' in profile) {
      window.localStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify(sanitizedProfile))
    }
    return sanitizedProfile
  } catch {
    return null
  }
}

const readRememberedSession = (profile: AuthProfile | null): AuthSession | null => {
  const rawSession = window.localStorage.getItem(AUTH_SESSION_KEY)
  if (!rawSession || !profile) {
    return null
  }
  try {
    const session = JSON.parse(rawSession) as Partial<AuthSession>
    if (
      session.username !== profile.username ||
      typeof session.expiresAt !== 'number' ||
      session.expiresAt <= Date.now()
    ) {
      window.localStorage.removeItem(AUTH_SESSION_KEY)
      return null
    }
    if ('password' in session) {
      window.localStorage.removeItem(AUTH_SESSION_KEY)
      return null
    }
    return {
      username: profile.username,
      expiresAt: session.expiresAt
    }
  } catch {
    window.localStorage.removeItem(AUTH_SESSION_KEY)
    return null
  }
}

const saveRememberedSession = (username: string) => {
  const session: AuthSession = {
    username,
    expiresAt: Date.now() + REMEMBER_LOGIN_MS
  }
  window.localStorage.setItem(AUTH_SESSION_KEY, JSON.stringify(session))
}

export const AppShell = () => {
  const { message, modal } = App.useApp()
  const location = useLocation()
  const navigate = useNavigate()
  const contentRef = useRef<HTMLElement | null>(null)
  const startWindowDrag = useWindowDrag()
  const [loginForm] = Form.useForm<LoginFormValues>()
  const [authProfile, setAuthProfile] = useState<AuthProfile | null>(() => readAuthProfile())
  const [authMode, setAuthMode] = useState<'login' | 'register'>('login')
  const [authenticated, setAuthenticated] = useState(false)
  const [authPassword, setAuthPassword] = useState<string | null>(null)
  const [loginSaving, setLoginSaving] = useState(false)
	  const [vaultStatus, setVaultStatus] = useState<{
	    exists: boolean
	    unlocked: boolean
	    itemCount: number
	  } | null>(null)
  useBackgroundTaskManager({
    enabled: authenticated,
    vaultUnlocked: vaultStatus?.unlocked === true
  })

  useEffect(() => {
    const session = readRememberedSession(authProfile)
    if (!session) {
      return
    }
    loginForm.setFieldsValue({
      username: session.username,
      remember: true
    })
  }, [authProfile, loginForm])

  useEffect(() => {
    if (!authenticated || !authPassword) {
      return
    }
    let cancelled = false
    const unlockVaultWithLoginPassword = async () => {
      try {
        const currentStatus = await window.emphant.secretVaultStatus()
        if (cancelled) return
        const nextStatus = currentStatus.unlocked
          ? currentStatus
          : await window.emphant.unlockSecretVault({ password: authPassword })
        if (!cancelled) {
          setVaultStatus(nextStatus)
        }
      } catch (error) {
        if (cancelled) return
        void message.error(error instanceof Error ? error.message : '登录密码无法解锁安全保险箱')
        setAuthenticated(false)
        setAuthPassword(null)
        setVaultStatus(null)
        window.localStorage.removeItem(AUTH_SESSION_KEY)
      }
    }
    void unlockVaultWithLoginPassword()
    return () => {
      cancelled = true
    }
  }, [authPassword, authenticated, message])

  const login = async () => {
    const values = await loginForm.validateFields()
    const username = values.username.trim()
    const password = values.password.trim()

    if (!authProfile) {
      void message.warning('还没有账号，请先注册')
      setAuthMode('register')
      return
    }
    if (username !== authProfile.username) {
      void message.error('用户名或密码不正确')
      return
    }

    setLoginSaving(true)
    try {
      await window.emphant.unlockSecretVault({ password })
      if (values.remember) {
        saveRememberedSession(authProfile.username)
      } else {
        window.localStorage.removeItem(AUTH_SESSION_KEY)
      }
      setAuthenticated(true)
      setAuthPassword(password)
      loginForm.resetFields()
      void message.success('已登录')
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '用户名或密码不正确')
    } finally {
      setLoginSaving(false)
    }
  }

  const register = async () => {
    const values = await loginForm.validateFields()
    const username = values.username.trim()
    const password = values.password.trim()
    const confirmPassword = values.confirmPassword?.trim()

    if (authProfile) {
      void message.warning('本机已注册账号，请直接登录')
      setAuthMode('login')
      return
    }
    if (username.length < 3) {
      void message.error('用户名至少需要 3 个字符')
      return
    }
    if (password.length < 8) {
      void message.error('密码至少需要 8 个字符')
      return
    }
    if (password !== confirmPassword) {
      void message.error('两次输入的密码不一致')
      return
    }

    setLoginSaving(true)
    try {
      const nextProfile = { username }
      try {
        await window.emphant.unlockSecretVault({ password })
      } catch (error) {
        const vaultStatusBeforeReset = await window.emphant.secretVaultStatus()
        if (!vaultStatusBeforeReset.exists) {
          throw error
        }
        const confirmed = await modal.confirm({
          title: '重建安全保险箱',
          content:
            '检测到本机已有旧安全保险箱，当前注册密码无法解锁。继续注册会清空旧保险箱并为新账号创建新的保险箱。',
          okText: '重建并注册',
          cancelText: '取消',
          okButtonProps: { danger: true }
        })
        if (!confirmed) {
          return
        }
        await window.emphant.resetSecretVault()
        await window.emphant.unlockSecretVault({ password })
      }
      window.localStorage.setItem(AUTH_PROFILE_KEY, JSON.stringify(nextProfile))
      setAuthProfile(nextProfile)
      if (values.remember) {
        saveRememberedSession(username)
      } else {
        window.localStorage.removeItem(AUTH_SESSION_KEY)
      }
      setAuthenticated(true)
      setAuthPassword(password)
      loginForm.resetFields()
      void message.success('注册成功，已登录')
    } catch (error) {
      void message.error(error instanceof Error ? error.message : '注册失败')
    } finally {
      setLoginSaving(false)
    }
  }

  const switchAuthMode = (mode: 'login' | 'register') => {
    setAuthMode(mode)
    loginForm.resetFields()
    loginForm.setFieldsValue({
      username: mode === 'login' ? authProfile?.username : undefined,
      remember: false
    })
  }

  const logout = () => {
    window.localStorage.removeItem(AUTH_SESSION_KEY)
    setAuthenticated(false)
    setAuthPassword(null)
    setVaultStatus(null)
    navigate('/')
    void window.emphant.lockSecretVault().catch(() => undefined)
  }

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

  if (!authenticated) {
    return (
      <Layout className="login-shell">
        <div
          className="window-drag-strip"
          data-tauri-drag-region=""
          onMouseDown={startWindowDrag}
        />
        <section className="login-panel">
          <Space direction="vertical" size={22} className="login-panel__content">
            <div className="login-brand">
              <Typography.Title level={2}>Emphant Studio</Typography.Title>
              <Typography.Text type="secondary">
                登录后将使用同一密码解锁本机安全保险箱
              </Typography.Text>
            </div>
            <Form
              form={loginForm}
              layout="vertical"
              initialValues={{ username: authProfile?.username, remember: false }}
              onFinish={() => void (authMode === 'login' ? login() : register())}
              className="login-form"
            >
              <Form.Item
                label="用户"
                name="username"
                rules={[{ required: true, message: '请输入用户名' }]}
              >
                <Input
                  autoFocus
                  prefix={<UserOutlined />}
                  autoComplete="username"
                  placeholder="请输入用户名"
                />
              </Form.Item>
              <Form.Item
                label="密码"
                name="password"
                rules={[{ required: true, message: '请输入密码' }]}
              >
                <Input.Password
                  prefix={<LockOutlined />}
                  autoComplete={authMode === 'login' ? 'current-password' : 'new-password'}
                  placeholder="请输入密码"
                />
              </Form.Item>
              {authMode === 'register' && (
                <Form.Item
                  label="确认密码"
                  name="confirmPassword"
                  dependencies={['password']}
                  rules={[
                    { required: true, message: '请再次输入密码' },
                    ({ getFieldValue }) => ({
                      validator(_, value) {
                        if (!value || getFieldValue('password') === value) {
                          return Promise.resolve()
                        }
                        return Promise.reject(new Error('两次输入的密码不一致'))
                      }
                    })
                  ]}
                >
                  <Input.Password autoComplete="new-password" />
                </Form.Item>
              )}
              <Form.Item name="remember" valuePropName="checked" className="login-remember">
                <Checkbox>记住用户名 7 天</Checkbox>
              </Form.Item>
              <Button type="primary" htmlType="submit" loading={loginSaving} block>
                {authMode === 'login' ? '登录' : '注册并登录'}
              </Button>
              <div className="login-switch">
                {authMode === 'login' ? (
                  <>
                    <Typography.Text type="secondary">还没有账号？</Typography.Text>
                    <Button type="link" onClick={() => switchAuthMode('register')}>
                      注册
                    </Button>
                  </>
                ) : (
                  <>
                    <Typography.Text type="secondary">已有账号？</Typography.Text>
                    <Button type="link" onClick={() => switchAuthMode('login')}>
                      返回登录
                    </Button>
                  </>
                )}
              </div>
            </Form>
          </Space>
        </section>
      </Layout>
    )
  }

  return (
    <Layout className="app-shell">
      <div
        className="window-drag-strip"
        data-tauri-drag-region=""
        onMouseDown={startWindowDrag}
      />
      <aside className="app-sidebar" data-tauri-drag-region="" onMouseDown={startWindowDrag}>
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
        <AppNavbar onLogout={logout} />
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
