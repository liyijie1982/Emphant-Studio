import {
  App,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Select,
  Space,
  Switch,
  Tag,
  Typography
} from 'antd'
import { FolderOpenOutlined } from '@ant-design/icons'
import { useEffect, useMemo, useState } from 'react'
import { clearWorkbenchSnapshot } from '@/lib/workbenchDb'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  resetWorkbench,
  deleteMcpServer,
  selectFiles,
  selectKnowledgeBases,
  selectMessages,
  selectMcpServers,
  selectMcpTools,
  selectProviders,
  selectSettings,
  selectSystemNotes,
  selectTodoGroups,
  selectTodoItems,
  selectTopics,
  updateMcpToolConfig,
  updateProviderConfig,
  updateSettings,
  upsertMcpServer
} from '@/store/workbenchSlice'
import type { McpServerConfig } from '@emphant/shared/types'

type SettingsSection = 'model' | 'runtime' | 'workspace' | 'providers' | 'persistence' | 'mcp'

const sectionLabels: Record<SettingsSection, string> = {
  model: '模型默认值',
  runtime: 'Agent 内核',
  workspace: '工作目录',
  providers: 'Provider 接入',
  persistence: '恢复与持久化',
  mcp: 'MCP 工具'
}

export const SettingsPage = () => {
  const dispatch = useAppDispatch()
  const { message } = App.useApp()
  const providers = useAppSelector(selectProviders)
  const tools = useAppSelector(selectMcpTools)
  const mcpServers = useAppSelector(selectMcpServers)
  const settings = useAppSelector(selectSettings)
  const systemNotes = useAppSelector(selectSystemNotes)
  const knowledgeBases = useAppSelector(selectKnowledgeBases)
  const files = useAppSelector(selectFiles)
  const topics = useAppSelector(selectTopics)
  const messages = useAppSelector(selectMessages)
  const todoGroups = useAppSelector(selectTodoGroups)
  const todoItems = useAppSelector(selectTodoItems)
  const [activeSection, setActiveSection] = useState<SettingsSection>('model')
  const [syncingProviderId, setSyncingProviderId] = useState<string | null>(null)
  const [providerSecrets, setProviderSecrets] = useState<Record<string, string>>({})
  const [savingCredentialId, setSavingCredentialId] = useState<string | null>(null)
  const [testingMcpId, setTestingMcpId] = useState<string | null>(null)
  const [editingMcpServer, setEditingMcpServer] = useState<McpServerConfig | null>(null)
  const [mcpCredential, setMcpCredential] = useState('')
  const [mcpForm] = Form.useForm<McpServerConfig>()

  const enabledProviders = useMemo(
    () => providers.filter((provider) => provider.enabled),
    [providers]
  )
  const selectedProvider =
    enabledProviders.find((provider) => provider.id === settings.defaultProviderId) ??
    enabledProviders[0]

  useEffect(() => {
    if (!selectedProvider) {
      return
    }

    const nextPatch: Partial<typeof settings> = {}
    if (settings.defaultProviderId !== selectedProvider.id) {
      nextPatch.defaultProviderId = selectedProvider.id
    }
    if (
      selectedProvider.models.length > 0 &&
      !selectedProvider.models.includes(settings.defaultModel)
    ) {
      nextPatch.defaultModel = selectedProvider.models[0]
    }
    if (Object.keys(nextPatch).length > 0) {
      dispatch(updateSettings(nextPatch))
    }
  }, [dispatch, selectedProvider, settings.defaultModel, settings.defaultProviderId])

  const handleDefaultProviderChange = (providerId: string) => {
    const provider = providers.find((item) => item.id === providerId)
    dispatch(
      updateSettings({
        defaultProviderId: providerId,
        defaultModel: provider?.models[0] ?? ''
      })
    )
    void message.success('默认模型设置已更新')
  }

  const handleSelectDefaultWorkingDirectory = async () => {
    try {
      const directory = await window.emphant.selectWorkspaceDirectory(
        settings.defaultWorkingDirectory || undefined
      )
      if (!directory) {
        return
      }
      await window.emphant.saveWorkspaceContent(directory, {
        systemNotes,
        knowledgeBases,
        files,
        topics,
        messages,
        todoGroups,
        todoItems
      })
      dispatch(updateSettings({ defaultWorkingDirectory: directory }))
      void message.success('工作目录已更新，知识库和笔记已迁移')
    } catch (error) {
      void message.error(
        error instanceof Error && error.message.includes('No handler registered')
          ? '主进程尚未加载目录选择功能，请重启应用后再试'
          : error instanceof Error
            ? error.message
            : '无法选择工作目录'
      )
    }
  }

  const handleProviderEnabledChange = (providerId: string, enabled: boolean) => {
    const provider = providers.find((item) => item.id === providerId)
    dispatch(updateProviderConfig({ providerId, patch: { enabled } }))

    if (!enabled && settings.defaultProviderId === providerId) {
      const fallbackProvider = providers.find((item) => item.id !== providerId && item.enabled)
      if (fallbackProvider) {
        dispatch(
          updateSettings({
            defaultProviderId: fallbackProvider.id,
            defaultModel: fallbackProvider.models[0] ?? ''
          })
        )
      }
    }

    void message.success(`${provider?.name ?? 'Provider'} 已${enabled ? '启用' : '停用'}`)
  }

  const handleSyncProviderModels = async (providerId: string) => {
    const provider = providers.find((item) => item.id === providerId)
    if (!provider) {
      return
    }

    setSyncingProviderId(providerId)
    try {
      const models = await window.emphant.listProviderModels(provider)
      dispatch(updateProviderConfig({ providerId, patch: { models } }))
      if (settings.defaultProviderId === providerId && !models.includes(settings.defaultModel)) {
        dispatch(updateSettings({ defaultModel: models[0] }))
      }
      void message.success(`${provider.name} 已同步 ${models.length} 个模型`)
    } catch (error) {
      void message.error(error instanceof Error ? error.message : `${provider.name} 模型同步失败`)
    } finally {
      setSyncingProviderId(null)
    }
  }

  const handleSaveProviderCredential = async (providerId: string) => {
    const secret = providerSecrets[providerId]?.trim()
    if (!secret) {
      return
    }

    setSavingCredentialId(providerId)
    try {
      await window.emphant.setCredential({ scope: 'provider', id: providerId, secret })
      dispatch(
        updateProviderConfig({
          providerId,
          patch: { credentialConfigured: true }
        })
      )
      setProviderSecrets((current) => ({ ...current, [providerId]: '' }))
      void message.success('API Key 已写入系统安全存储')
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'API Key 保存失败')
    } finally {
      setSavingCredentialId(null)
    }
  }

  const openMcpEditor = (server?: McpServerConfig) => {
    const next =
      server ?? {
        id: crypto.randomUUID(),
        name: '',
        enabled: true,
        transport: 'http' as const,
        url: '',
        service: 'generic' as const,
        preset: false,
        authMode: 'header' as const,
        authHeaderName: 'Authorization',
        credentialConfigured: false,
        enabledToolNames: [],
        discoveredTools: []
      }
    setEditingMcpServer(next)
    setMcpCredential('')
    mcpForm.setFieldsValue(next)
  }

  const handleSaveMcpServer = async () => {
    if (!editingMcpServer) {
      return
    }
    const values = await mcpForm.validateFields()
    const server = { ...editingMcpServer, ...values }

    if (mcpCredential.trim()) {
      await window.emphant.setCredential({
        scope: 'mcp',
        id: server.id,
        secret: mcpCredential.trim()
      })
      server.credentialConfigured = true
    }

    dispatch(upsertMcpServer(server))
    setEditingMcpServer(null)
    void message.success('MCP Server 已保存')
  }

  const handleTestMcpServer = async (server: McpServerConfig) => {
    setTestingMcpId(server.id)
    try {
      const result = await window.emphant.testMcpServer(server)
      dispatch(
        upsertMcpServer({
          ...server,
          discoveredTools: result.tools,
          enabledToolNames:
            server.enabledToolNames?.length
              ? server.enabledToolNames
              : result.tools.map((tool) => tool.name)
        })
      )
      void message.success(`连接成功，发现 ${result.tools.length} 个工具`)
    } catch (error) {
      void message.error(error instanceof Error ? error.message : 'MCP Server 连接失败')
    } finally {
      setTestingMcpId(null)
    }
  }

  const handleResetWorkspace = async () => {
    for (const provider of providers) {
      await window.emphant.deleteCredential({ scope: 'provider', id: provider.id })
    }
    for (const server of mcpServers) {
      await window.emphant.deleteCredential({ scope: 'mcp', id: server.id })
    }
    await clearWorkbenchSnapshot()
    dispatch(resetWorkbench())
    void message.success('本地数据已重置为初始状态')
  }

  return (
    <div className="settings-layout">
      <aside className="settings-layout__sidebar">
        <Card className="workspace-panel page-panel" bordered={false}>
          <Typography.Title level={4}>设置</Typography.Title>
          <Typography.Paragraph type="secondary">
            默认模型、Provider、恢复策略和 MCP 工具会立即保存到本地。
          </Typography.Paragraph>
          <div className="settings-nav">
            {(Object.keys(sectionLabels) as SettingsSection[]).map((section) => (
              <button
                key={section}
                className={
                  activeSection === section
                    ? 'settings-nav__item is-active'
                    : 'settings-nav__item'
                }
                onClick={() => setActiveSection(section)}
                type="button"
              >
                <span>{sectionLabels[section]}</span>
                {section === 'providers' && (
                  <Tag bordered={false}>
                    {enabledProviders.length}/{providers.length}
                  </Tag>
                )}
                {section === 'mcp' && (
                  <Tag bordered={false}>
                    {tools.filter((tool) => tool.enabled).length}/{tools.length}
                  </Tag>
                )}
                {section === 'runtime' && (
                  <Tag bordered={false}>
                    {settings.openClawCore?.enabled ? 'OpenClaw' : '内置'}
                  </Tag>
                )}
              </button>
            ))}
          </div>
        </Card>
      </aside>

      <section className="settings-layout__content">
        {activeSection === 'model' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>模型默认值</Typography.Title>
            <Typography.Paragraph type="secondary">
              新建 Agent 时会默认使用这里选择的 Provider 和模型；已有 Agent 保持自己的独立配置。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form">
              <Form.Item label="默认 Provider">
                <Select
                  value={selectedProvider?.id}
                  options={enabledProviders.map((provider) => ({
                    label: provider.name,
                    value: provider.id
                  }))}
                  placeholder="先启用至少一个 Provider"
                  onChange={handleDefaultProviderChange}
                />
              </Form.Item>
              <Form.Item label="默认模型">
                <Select
                  value={settings.defaultModel}
                  disabled={!selectedProvider || selectedProvider.models.length === 0}
                  options={(selectedProvider?.models ?? []).map((model) => ({
                    label: model,
                    value: model
                  }))}
                  placeholder={
                    selectedProvider ? '先在 Provider 接入中同步模型' : '先启用至少一个 Provider'
                  }
                  onChange={(value) => {
                    dispatch(updateSettings({ defaultModel: value }))
                    void message.success('默认模型已更新')
                  }}
                />
              </Form.Item>
              <Form.Item label="Provider 失败时回退到本地模拟回复">
                <Switch
                  checked={settings.useMockResponsesWhenProviderFails}
                  onChange={(checked) =>
                    dispatch(updateSettings({ useMockResponsesWhenProviderFails: checked }))
                  }
                />
              </Form.Item>
            </Form>
          </Card>
        )}

        {activeSection === 'runtime' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>Agent 内核</Typography.Title>
            <Typography.Paragraph type="secondary">
              OpenClaw Core 负责多 Agent 调度、模型调用和工具策略，可在工作台对话中自动委派专业 Agent。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form">
              <Form.Item label="运行时">
                <Select
                  value={settings.openClawCore?.enabled ? 'openclaw-core' : 'builtin'}
                  options={[
                    { label: '内嵌 OpenClaw Core', value: 'openclaw-core' },
                    { label: '传统单 Agent Runtime', value: 'builtin' }
                  ]}
                  onChange={(value) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: value === 'openclaw-core',
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                          auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                          requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                        }
                      })
                    )
                  }
                />
              </Form.Item>
              <Form.Item label="Sandbox">
                <Space wrap>
                  <Switch
                    checked={settings.openClawCore?.sandboxEnabled ?? false}
                    checkedChildren="开启"
                    unCheckedChildren="关闭"
                    onChange={(checked) =>
                      dispatch(
                        updateSettings({
                          openClawCore: {
                            enabled: settings.openClawCore?.enabled ?? true,
                            sandboxEnabled: checked,
                            maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                            auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                            requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                          }
                        })
                      )
                    }
                  />
                  <Tag color={(settings.openClawCore?.sandboxEnabled ?? false) ? 'blue' : 'red'}>
                    {(settings.openClawCore?.sandboxEnabled ?? false)
                      ? '工具隔离执行'
                      : 'Host 模式'}
                  </Tag>
                </Space>
              </Form.Item>
              <Form.Item label="最大委派 Agent 数">
                <Select
                  value={settings.openClawCore?.maxDelegatedAgents ?? 3}
                  options={[1, 2, 3, 4, 5].map((value) => ({
                    label: `${value} 个`,
                    value
                  }))}
                  onChange={(value) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: settings.openClawCore?.enabled ?? true,
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: value,
                          auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                          requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                        }
                      })
                    )
                  }
                />
              </Form.Item>
              <Form.Item label="运行审计日志">
                <Switch
                  checked={settings.openClawCore?.auditLogEnabled ?? true}
                  onChange={(checked) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: settings.openClawCore?.enabled ?? true,
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                          auditLogEnabled: checked,
                          requireToolApproval: settings.openClawCore?.requireToolApproval ?? false
                        }
                      })
                    )
                  }
                />
              </Form.Item>
              <Form.Item label="工具调用前要求授权">
                <Switch
                  checked={settings.openClawCore?.requireToolApproval ?? false}
                  onChange={(checked) =>
                    dispatch(
                      updateSettings({
                        openClawCore: {
                          enabled: settings.openClawCore?.enabled ?? true,
                          sandboxEnabled: settings.openClawCore?.sandboxEnabled ?? false,
                          maxDelegatedAgents: settings.openClawCore?.maxDelegatedAgents ?? 3,
                          auditLogEnabled: settings.openClawCore?.auditLogEnabled ?? true,
                          requireToolApproval: checked
                        }
                      })
                    )
                  }
                />
              </Form.Item>
            </Form>
          </Card>
        )}

        {activeSection === 'workspace' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>默认工作目录</Typography.Title>
            <Typography.Paragraph type="secondary">
              笔记和知识库以文件形式保存在此目录的 Emphant Studio 文件夹中。新建会话也会继承这个目录，Agent
              的文件操作限制在当前会话工作目录内。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form">
              <Form.Item label="目录路径">
                <Input
                  readOnly
                  value={settings.defaultWorkingDirectory}
                  placeholder="正在准备默认工作目录"
                  addonAfter={
                    <Button
                      type="text"
                      size="small"
                      icon={<FolderOpenOutlined />}
                      onClick={() => void handleSelectDefaultWorkingDirectory()}
                    >
                      选择
                    </Button>
                  }
                />
              </Form.Item>
              <Space wrap>
                <Button
                  type="primary"
                  icon={<FolderOpenOutlined />}
                  onClick={() => void handleSelectDefaultWorkingDirectory()}
                >
                  选择默认目录
                </Button>
                <Button
                  onClick={async () => {
                    const directory = await window.emphant.getDefaultWorkspaceDirectory()
                    await window.emphant.saveWorkspaceContent(directory, {
                      systemNotes,
                      knowledgeBases,
                      files,
                      topics,
                      messages,
                      todoGroups,
                      todoItems
                    })
                    dispatch(updateSettings({ defaultWorkingDirectory: directory }))
                    void message.success('已恢复默认工作目录，知识库和笔记已迁移')
                  }}
                >
                  恢复默认
                </Button>
              </Space>
            </Form>
          </Card>
        )}

        {activeSection === 'providers' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>Provider 接入</Typography.Title>
            <Typography.Paragraph type="secondary">
              停用 Provider 后，它不会再作为默认项或新 Agent 可选项；已绑定该 Provider 的 Agent 会提示配置不可用。
            </Typography.Paragraph>
            <div className="settings-card-grid">
              {providers.map((provider) => {
                const canDisable = provider.enabled && enabledProviders.length <= 1
                return (
                  <div key={provider.id} className="provider-card">
                    <div className="settings-card-header">
                      <div>
                        <strong>{provider.name}</strong>
                        <span>{provider.kind === 'local' ? '本地模型' : '云模型'}</span>
                      </div>
                      <Switch
                        checked={provider.enabled}
                        disabled={canDisable}
                        onChange={(checked) => handleProviderEnabledChange(provider.id, checked)}
                      />
                    </div>
                    <Input
                      size="small"
                      value={provider.baseUrl}
                      placeholder="Base URL"
                      onChange={(event) =>
                        dispatch(
                          updateProviderConfig({
                            providerId: provider.id,
                            patch: { baseUrl: event.target.value }
                          })
                        )
                      }
                      onBlur={() => void message.success(`${provider.name} Base URL 已保存`)}
                    />
                    <Input.Password
                      size="small"
                      value={providerSecrets[provider.id] ?? ''}
                      placeholder={
                        provider.credentialConfigured
                          ? '已安全保存；输入新值可替换'
                          : provider.apiKeyHint
                      }
                      onChange={(event) =>
                        setProviderSecrets((current) => ({
                          ...current,
                          [provider.id]: event.target.value
                        }))
                      }
                    />
                    {provider.id !== 'provider-ollama' && (
                      <Space>
                        <Button
                          size="small"
                          type="primary"
                          disabled={!providerSecrets[provider.id]?.trim()}
                          loading={savingCredentialId === provider.id}
                          onClick={() => void handleSaveProviderCredential(provider.id)}
                        >
                          保存到安全存储
                        </Button>
                        <Tag color={provider.credentialConfigured ? 'green' : 'default'}>
                          {provider.credentialConfigured ? '已配置' : '未配置'}
                        </Tag>
                      </Space>
                    )}
                    <div className="provider-card__models">
                      <div className="provider-card__models-header">
                        <span>支持模型</span>
                        <Button
                          size="small"
                          loading={syncingProviderId === provider.id}
                          onClick={() => void handleSyncProviderModels(provider.id)}
                        >
                          同步模型
                        </Button>
                      </div>
                      {provider.models.length > 0 ? (
                        <Space wrap size={[4, 4]}>
                          {provider.models.slice(0, 8).map((model) => (
                            <Tag key={model}>{model}</Tag>
                          ))}
                          {provider.models.length > 8 && (
                            <Tag bordered={false}>+{provider.models.length - 8}</Tag>
                          )}
                        </Space>
                      ) : (
                        <Typography.Text type="secondary">还没有同步到模型</Typography.Text>
                      )}
                    </div>
                    <Space wrap>
                      {provider.capabilities.map((capability) => (
                        <Tag key={capability}>{capability}</Tag>
                      ))}
                    </Space>
                  </div>
                )
              })}
            </div>
          </Card>
        )}

        {activeSection === 'persistence' && (
          <Card className="workspace-panel" bordered={false}>
            <Typography.Title level={4}>恢复与持久化</Typography.Title>
            <Typography.Paragraph type="secondary">
              设置、Provider 和 MCP 开关始终保留；这个开关只控制下次启动是否恢复聊天工作区、当前 Agent 和任务上下文。
            </Typography.Paragraph>
            <Form layout="vertical" className="settings-form">
              <Form.Item label="启动时恢复上次工作区">
                <Switch
                  checked={settings.restoreWorkspaceOnLaunch}
                  onChange={(checked) =>
                    dispatch(updateSettings({ restoreWorkspaceOnLaunch: checked }))
                  }
                />
              </Form.Item>
              <Form.Item label="重置本地工作区数据">
                <Popconfirm
                  title="重置本地工作区数据？"
                  description="会清空当前聊天、Agent、知识库、文件和设置，恢复到初始演示数据。"
                  onConfirm={() => void handleResetWorkspace()}
                >
                  <Button danger>重置为初始状态</Button>
                </Popconfirm>
              </Form.Item>
            </Form>
          </Card>
        )}

        {activeSection === 'mcp' && (
          <Card className="workspace-panel page-panel" bordered={false}>
            <div className="settings-card-header">
              <div>
                <Typography.Title level={4}>MCP Server</Typography.Title>
                <Typography.Paragraph type="secondary">
                  配置 HTTP/SSE Server，连接测试后选择允许暴露给 Agent 的工具。已内置
                  Firecrawl、Todoist 和 Notion 候选配置。
                </Typography.Paragraph>
              </div>
              <Button type="primary" onClick={() => openMcpEditor()}>
                添加 Server
              </Button>
            </div>
            {mcpServers.length > 0 ? (
              <div className="settings-card-grid">
                {mcpServers.map((server) => (
                  <div key={server.id} className="provider-card">
                    <div className="settings-card-header">
                      <div>
                        <strong>{server.name}</strong>
                        <span>{server.url}</span>
                      </div>
                      <Switch
                        checked={server.enabled}
                        onChange={(enabled) => dispatch(upsertMcpServer({ ...server, enabled }))}
                      />
                    </div>
                    <Space wrap>
                      <Tag>{server.transport.toUpperCase()}</Tag>
                      {server.preset && <Tag color="blue">推荐预置</Tag>}
                      <Tag>{server.authMode ?? 'header'}</Tag>
                      <Tag color={server.credentialConfigured ? 'green' : 'default'}>
                        {server.credentialConfigured ? '已配置凭据' : '无凭据'}
                      </Tag>
                      <Tag>
                        {server.enabledToolNames?.length ?? 0}/
                        {server.discoveredTools?.length ?? 0} 工具
                      </Tag>
                    </Space>
                    <Space wrap>
                      <Button size="small" onClick={() => openMcpEditor(server)}>
                        编辑
                      </Button>
                      {server.docsUrl && (
                        <Button size="small" href={server.docsUrl} target="_blank">
                          文档
                        </Button>
                      )}
                      <Button
                        size="small"
                        loading={testingMcpId === server.id}
                        onClick={() => void handleTestMcpServer(server)}
                      >
                        测试并发现工具
                      </Button>
                      <Popconfirm
                        title={`删除 ${server.name}？`}
                        onConfirm={async () => {
                          await window.emphant.deleteCredential({ scope: 'mcp', id: server.id })
                          dispatch(deleteMcpServer(server.id))
                        }}
                      >
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="还没有配置 MCP Server" />
            )}

            <Typography.Title level={5}>内置工具开关</Typography.Title>
            <Typography.Paragraph type="secondary">
              关闭工具后，即使 Agent 仍挂载了该工具，聊天运行时也不会调用它。
            </Typography.Paragraph>
            {tools.length > 0 ? (
              <div className="settings-card-grid">
                {tools.map((tool) => (
                  <div key={tool.id} className="provider-card">
                    <div className="settings-card-header">
                      <div>
                        <strong>{tool.name}</strong>
                        <span>{tool.description}</span>
                      </div>
                      <Switch
                        checked={tool.enabled}
                        onChange={(checked) =>
                          dispatch(
                            updateMcpToolConfig({
                              toolId: tool.id,
                              patch: { enabled: checked }
                            })
                          )
                        }
                      />
                    </div>
                    <Space wrap>
                      <Tag color={tool.enabled ? 'blue' : 'default'}>{tool.serverName}</Tag>
                      <Tag>{tool.category}</Tag>
                    </Space>
                  </div>
                ))}
              </div>
            ) : (
              <Empty description="还没有接入 MCP 工具" />
            )}
          </Card>
        )}
      </section>

      <Modal
        open={Boolean(editingMcpServer)}
        title={editingMcpServer?.name ? `编辑 ${editingMcpServer.name}` : '添加 MCP Server'}
        onCancel={() => setEditingMcpServer(null)}
        onOk={() => void handleSaveMcpServer()}
      >
        <Form form={mcpForm} layout="vertical">
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input placeholder="例如 Company Search" />
          </Form.Item>
          <Form.Item name="transport" label="Transport" rules={[{ required: true }]}>
            <Select
              options={[
                { label: 'Streamable HTTP', value: 'http' },
                { label: 'SSE', value: 'sse' }
              ]}
            />
          </Form.Item>
          <Form.Item name="service" label="服务类型">
            <Select
              options={[
                { label: '通用 MCP', value: 'generic' },
                { label: 'Firecrawl', value: 'firecrawl' },
                { label: 'Todoist', value: 'todoist' },
                { label: 'Notion', value: 'notion' },
                { label: 'Google Workspace', value: 'google-workspace' }
              ]}
            />
          </Form.Item>
          <Form.Item
            name="url"
            label="Server URL"
            rules={[
              { required: true },
              { type: 'url', message: '请输入有效的 HTTP(S) URL' }
            ]}
          >
            <Input placeholder="https://example.com/mcp" />
          </Form.Item>
          <Form.Item name="authHeaderName" label="认证 Header">
            <Input placeholder="Authorization" />
          </Form.Item>
          <Form.Item name="authMode" label="认证方式">
            <Select
              options={[
                { label: '无需认证', value: 'none' },
                { label: 'Header Token', value: 'header' },
                { label: 'OAuth Access Token（过渡）', value: 'oauth' }
              ]}
            />
          </Form.Item>
          <Form.Item label="认证值">
            <Input.Password
              value={mcpCredential}
              placeholder={
                editingMcpServer?.credentialConfigured
                  ? '已安全保存；输入新值可替换'
                  : editingMcpServer?.authMode === 'oauth'
                    ? '当前请填入 Bearer access token'
                    : '例如 Bearer token'
              }
              onChange={(event) => setMcpCredential(event.target.value)}
            />
          </Form.Item>
          {(editingMcpServer?.discoveredTools?.length ?? 0) > 0 && (
            <Form.Item name="enabledToolNames" label="启用工具">
              <Select
                mode="multiple"
                options={editingMcpServer?.discoveredTools?.map((tool) => ({
                  label: tool.description ? `${tool.name} — ${tool.description}` : tool.name,
                  value: tool.name
                }))}
              />
            </Form.Item>
          )}
        </Form>
      </Modal>
    </div>
  )
}
