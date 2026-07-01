import {
  ApartmentOutlined,
  CheckCircleOutlined,
  ClockCircleOutlined,
  DeleteOutlined,
  ExclamationCircleOutlined,
  FileImageOutlined,
  FileTextOutlined,
  FolderOpenOutlined,
  LoadingOutlined,
  PlusOutlined,
  RedoOutlined,
  SearchOutlined,
  SyncOutlined,
  UploadOutlined
} from '@ant-design/icons'
import { nanoid } from '@reduxjs/toolkit'
import {
  App,
  Alert,
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Progress,
  Space,
  Tag,
  Tabs,
  Typography
} from 'antd'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { saveWorkspaceContentNow } from '@/store'
import {
  addFileToKnowledgeBase,
  applyKnowledgeExtractionEvent,
  createKnowledgeBase,
  deleteKnowledgeBase,
  removeFileFromKnowledgeBase,
  selectFiles,
  selectKnowledgeBases,
  selectSettings
} from '@/store/workbenchSlice'
import { KnowledgeGraphVisual } from './KnowledgeGraphVisual'
import type { FileRecord, KnowledgeGraph } from '@emphant/shared/types'

const PROCESSING_STATUSES = new Set(['queued', 'extracting', 'indexing'])

const getSourceLabel = (source?: string) =>
  source === 'builtin' ? '系统预设' : source === 'user' || !source ? '用户资产' : source

const getSourceTagColor = (source?: string) =>
  source === 'builtin' ? 'geekblue' : source === 'user' || !source ? 'green' : 'purple'

const readImagePreview = (file: File) =>
  new Promise<string | undefined>((resolve) => {
    if (!file.type.startsWith('image/')) {
      resolve(undefined)
      return
    }
    const reader = new FileReader()
    reader.onload = () =>
      resolve(typeof reader.result === 'string' ? reader.result : undefined)
    reader.onerror = () => resolve(undefined)
    reader.readAsDataURL(file)
  })

const removeFileFromGraph = (
  graph: KnowledgeGraph | undefined,
  fileId: string
): KnowledgeGraph => {
  if (!graph) return { nodes: [], edges: [], facts: [] }
  const nodes = graph.nodes.filter((node) => !node.sourceFileIds.includes(fileId))
  const nodeIds = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: graph.edges.filter(
      (edge) =>
        !edge.sourceFileIds.includes(fileId) &&
        nodeIds.has(edge.sourceNodeId) &&
        nodeIds.has(edge.targetNodeId)
    ),
    facts: graph.facts.filter(
      (fact) =>
        !fact.sourceFileIds.includes(fileId) &&
        (!fact.subjectNodeId || nodeIds.has(fact.subjectNodeId))
    )
  }
}

const statusPresentation = (file: FileRecord) => {
  switch (file.knowledgeStatus) {
    case 'queued':
      return { color: 'default', icon: <ClockCircleOutlined />, label: '等待提取' }
    case 'extracting':
      return { color: 'processing', icon: <LoadingOutlined />, label: '解析正文' }
    case 'indexing':
      return { color: 'processing', icon: <LoadingOutlined />, label: '生成知识图谱' }
    case 'failed':
      return { color: 'error', icon: <ExclamationCircleOutlined />, label: '生成失败' }
    default:
      return { color: 'success', icon: <CheckCircleOutlined />, label: '已生成' }
  }
}

const formatFileSize = (size: number) => {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

export const KnowledgePage = () => {
  const dispatch = useAppDispatch()
  const { message: messageApi } = App.useApp()
  const knowledgeBases = useAppSelector(selectKnowledgeBases)
  const files = useAppSelector(selectFiles)
  const settings = useAppSelector(selectSettings)
  const providers = useAppSelector((state) => state.workbench.providers)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [activeBaseId, setActiveBaseId] = useState<string | null>(
    knowledgeBases[0]?.id ?? null
  )
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [previewFile, setPreviewFile] = useState<FileRecord | null>(null)
  const [query, setQuery] = useState('')
  const [failureFile, setFailureFile] = useState<FileRecord | null>(null)
  const [isGraphOpen, setIsGraphOpen] = useState(false)
  const [form] = Form.useForm<{ name: string; description: string }>()

  const activeBase = useMemo(
    () => knowledgeBases.find((base) => base.id === activeBaseId) ?? null,
    [activeBaseId, knowledgeBases]
  )
  const activeFiles = useMemo(
    () =>
      activeBase
        ? activeBase.sourceFileIds
            .map((fileId) => files.find((file) => file.id === fileId))
            .filter((file): file is FileRecord => Boolean(file))
        : [],
    [activeBase, files]
  )
  const filteredKnowledgeBases = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return knowledgeBases
    }

    return knowledgeBases.filter((base) =>
      [base.name, base.description].some((value) =>
        value.toLowerCase().includes(normalizedQuery)
      )
    )
  }, [knowledgeBases, query])
  const isIndexing = activeFiles.some((file) =>
    PROCESSING_STATUSES.has(file.knowledgeStatus ?? '')
  )
  const graphNodeNames = useMemo(
    () =>
      new Map(
        (activeBase?.graph?.nodes ?? []).map((node) => [node.id, node.name])
      ),
    [activeBase?.graph?.nodes]
  )
  const hasGraphContent = Boolean(
    activeBase?.graph &&
      (activeBase.graph.nodes.length > 0 ||
        activeBase.graph.edges.length > 0 ||
        activeBase.graph.facts.length > 0)
  )
  const previewChunks = useMemo(
    () =>
      previewFile && activeBase?.chunks
        ? activeBase.chunks.filter((chunk) => chunk.sourceFileId === previewFile.id)
        : [],
    [activeBase?.chunks, previewFile]
  )
  const previewGraphSources = useMemo(() => {
    if (!previewFile || !activeBase?.graph) {
      return { nodes: [], edges: [], facts: [] }
    }
    return {
      nodes: activeBase.graph.nodes.filter((node) =>
        node.sourceFileIds.includes(previewFile.id)
      ),
      edges: activeBase.graph.edges.filter((edge) =>
        edge.sourceFileIds.includes(previewFile.id)
      ),
      facts: activeBase.graph.facts.filter((fact) =>
        fact.sourceFileIds.includes(previewFile.id)
      )
    }
  }, [activeBase?.graph, previewFile])
  const indexingProvider = providers.find(
    (provider) => provider.id === settings.defaultProviderId && provider.enabled
  )
  const knowledgeReady = Boolean(settings.defaultWorkingDirectory && indexingProvider)
  const knowledgeReadinessMessage = !settings.defaultWorkingDirectory
    ? '请先在设置中选择工作目录，知识会保存到该目录下。'
    : !indexingProvider
      ? '请先在设置中启用默认对话模型，导入后才能抽取切片和知识图谱。'
      : ''

  useEffect(() => {
    if (!activeBaseId || !knowledgeBases.some((base) => base.id === activeBaseId)) {
      setActiveBaseId(knowledgeBases[0]?.id ?? null)
    }
  }, [activeBaseId, knowledgeBases])

  useEffect(
    () =>
      window.emphant.onKnowledgeExtractionEvent((event) => {
        dispatch(applyKnowledgeExtractionEvent(event))
        if (event.status === 'ready' || event.status === 'failed') {
          void saveWorkspaceContentNow()
        }
      }),
    [dispatch]
  )

  const handleCreate = async () => {
    const values = await form.validateFields()
    const id = nanoid()
    dispatch(
      createKnowledgeBase({
        id,
        name: values.name.trim(),
        description: values.description?.trim() ?? '',
        sourceFileIds: []
      })
    )
    setActiveBaseId(id)
    setIsCreateOpen(false)
    form.resetFields()
  }

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    if (!activeBase) return
    if (!knowledgeReady) {
      void messageApi.warning(knowledgeReadinessMessage)
      if (fileInputRef.current) {
        fileInputRef.current.value = ''
      }
      return
    }
    if (!indexingProvider) return

    const selectedFiles = Array.from(event.target.files ?? [])
    const embeddingProvider = providers.find(
      (provider) => provider.id === settings.defaultEmbeddingProviderId && provider.enabled
    )
    const rerankProvider = providers.find(
      (provider) => provider.id === settings.defaultRerankProviderId && provider.enabled
    )
    const pendingJobs: Array<{
      file: FileRecord
      bytes: Uint8Array
    }> = []

    for (const file of selectedFiles) {
      const fileId = nanoid()
      const bytes = new Uint8Array(await file.arrayBuffer())
      let originalRelativePath: string
      try {
        originalRelativePath = await window.emphant.saveKnowledgeSource({
          workspaceDirectory: settings.defaultWorkingDirectory,
          knowledgeBaseId: activeBase.id,
          knowledgeBaseName: activeBase.name,
          fileId,
          fileName: file.name,
          bytes
        })
      } catch (error) {
        void messageApi.error(
          error instanceof Error
            ? `${file.name} 原始资产保存失败：${error.message}`
            : `${file.name} 原始资产保存失败`
        )
        continue
      }
      const uploadedFile: FileRecord = {
        id: fileId,
        name: file.name,
        mimeType: file.type || 'application/octet-stream',
        size: file.size,
        uploadedAt: new Date().toISOString(),
        originalRelativePath,
        preview: await readImagePreview(file),
        knowledgeStatus: 'queued',
        knowledgeProgress: 5
      }
      dispatch(
        addFileToKnowledgeBase({
          knowledgeBaseId: activeBase.id,
          file: uploadedFile
        })
      )
      pendingJobs.push({ file: uploadedFile, bytes })
    }

    if (pendingJobs.length > 0) {
      try {
        await saveWorkspaceContentNow()
        void messageApi.success(
          `${pendingJobs.length} 个资产已导入，知识提取将在后台进行`
        )
      } catch (error) {
        void messageApi.error(
              error instanceof Error
            ? `资产未能保存到工作目录：${error.message}`
            : '资产未能保存到工作目录'
        )
      }

      for (const { file, bytes } of pendingJobs) {
        try {
          await window.emphant.startKnowledgeExtraction({
            jobId: nanoid(),
            knowledgeBaseId: activeBase.id,
            provider: indexingProvider,
            model: settings.defaultModel,
            embeddingProvider,
            embeddingModel: settings.defaultEmbeddingModel,
            rerankProvider,
            rerankModel: settings.defaultRerankModel,
            fileId: file.id,
            fileName: file.name,
            mimeType: file.mimeType,
            bytes,
            existingGraph: activeBase.graph
          })
        } catch (error) {
          dispatch(
            applyKnowledgeExtractionEvent({
              jobId: nanoid(),
              knowledgeBaseId: activeBase.id,
              fileId: file.id,
              status: 'failed',
              progress: 100,
              error: error instanceof Error ? error.message : '无法启动知识提取任务',
              completedAt: new Date().toISOString()
            })
          )
        }
      }
      await saveWorkspaceContentNow()
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const startExtraction = async (
    file: FileRecord,
    existingGraph: KnowledgeGraph,
    sourceBytes?: Uint8Array
  ) => {
    if (!activeBase || PROCESSING_STATUSES.has(file.knowledgeStatus ?? '')) return
    const embeddingProvider = providers.find(
      (provider) => provider.id === settings.defaultEmbeddingProviderId && provider.enabled
    )
    const rerankProvider = providers.find(
      (provider) => provider.id === settings.defaultRerankProviderId && provider.enabled
    )
    if (!knowledgeReady || !indexingProvider) {
      void messageApi.error(knowledgeReadinessMessage || '默认模型不可用，无法生成知识图谱。')
      return
    }
    if (!file.originalRelativePath) {
      void messageApi.error('找不到原始文件，无法重新生成。')
      return
    }

    dispatch(
      applyKnowledgeExtractionEvent({
        jobId: nanoid(),
        knowledgeBaseId: activeBase.id,
        fileId: file.id,
        status: 'queued',
        progress: 5
      })
    )
    try {
      const bytes =
        sourceBytes ??
        new Uint8Array(
          await window.emphant.readKnowledgeSource({
            workspaceDirectory: settings.defaultWorkingDirectory,
            relativePath: file.originalRelativePath
          })
        )
      await window.emphant.startKnowledgeExtraction({
        jobId: nanoid(),
        knowledgeBaseId: activeBase.id,
        provider: indexingProvider,
        model: settings.defaultModel,
        embeddingProvider,
        embeddingModel: settings.defaultEmbeddingModel,
        rerankProvider,
        rerankModel: settings.defaultRerankModel,
        fileId: file.id,
        fileName: file.name,
        mimeType: file.mimeType,
        bytes,
        existingGraph
      })
    } catch (error) {
      dispatch(
        applyKnowledgeExtractionEvent({
          jobId: nanoid(),
          knowledgeBaseId: activeBase.id,
          fileId: file.id,
          status: 'failed',
          progress: 100,
          error: error instanceof Error ? error.message : '无法读取原始文件',
          completedAt: new Date().toISOString()
        })
      )
    }
  }

  const handleRebuildGraph = async () => {
    if (!activeBase || activeFiles.length === 0 || isIndexing) return
    const readableFiles = await Promise.all(
      activeFiles.map(async (file) => {
        if (!file.originalRelativePath) return null
        try {
          const bytes = await window.emphant.readKnowledgeSource({
            workspaceDirectory: settings.defaultWorkingDirectory,
            relativePath: file.originalRelativePath
          })
          return { file, bytes: new Uint8Array(bytes) }
        } catch {
          return null
        }
      })
    )
    const initialGraph: KnowledgeGraph = { nodes: [], edges: [], facts: [] }
    for (const entry of readableFiles) {
      if (entry) {
        await startExtraction(entry.file, initialGraph, entry.bytes)
      }
    }
    void messageApi.info('已提交全部资产的重新生成任务')
  }

  return (
    <>
      <section className="knowledge-workspace">
        <Card className="workspace-panel knowledge-sidebar" variant="borderless">
          <div className="knowledge-panel-header">
            <Typography.Title level={4}>知识</Typography.Title>
            <Button
              type="text"
              className="knowledge-create-button"
              icon={<PlusOutlined />}
              aria-label="新建资产库"
              onClick={() => setIsCreateOpen(true)}
            />
          </div>

          <Input
            allowClear
            value={query}
            prefix={<SearchOutlined />}
            placeholder="搜索名称或描述"
            onChange={(event) => setQuery(event.target.value)}
            className="sidebar-list-search"
          />

          <div className="knowledge-base-list">
            {filteredKnowledgeBases.length ? (
              filteredKnowledgeBases.map((base) => (
                <div
                  key={base.id}
                  className={
                    base.id === activeBaseId
                      ? 'knowledge-base-item is-active'
                      : 'knowledge-base-item'
                  }
                >
                  <button type="button" onClick={() => setActiveBaseId(base.id)}>
                    <FolderOpenOutlined />
                    <span>
                      <strong>{base.name}</strong>
                      <small>
                        {base.sourceFileIds.length} 个资产 · {base.chunkCount} 个切片
                        {base.graph
                          ? ` · ${base.graph.nodes.length} 个实体 · ${base.graph.edges.length} 条关系`
                          : ''}
                      </small>
                      <Tag color={getSourceTagColor(base.source)}>
                        {getSourceLabel(base.source)}
                      </Tag>
                    </span>
                  </button>
              <Popconfirm
                title="删除资产库"
                description="资产库、索引和关联资产会一并移除。"
                    okText="删除"
                    cancelText="取消"
                    okButtonProps={{ danger: true }}
                    onConfirm={() => dispatch(deleteKnowledgeBase(base.id))}
                  >
                    <Button
                      type="text"
                      danger
                      icon={<DeleteOutlined />}
                      aria-label={`删除 ${base.name}`}
                    />
                  </Popconfirm>
                </div>
              ))
            ) : (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description={
                  knowledgeBases.length === 0 ? '还没有资产库' : '没有匹配的资产库'
                }
              >
                {knowledgeBases.length === 0 && (
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => setIsCreateOpen(true)}
                  >
                    新建资产库
                  </Button>
                )}
              </Empty>
            )}
          </div>
        </Card>

        <Card className="workspace-panel knowledge-files-panel" variant="borderless">
          {activeBase ? (
            <>
              <div className="knowledge-files-header">
                <div>
                  <Typography.Title level={4}>{activeBase.name}</Typography.Title>
	                  <Typography.Text type="secondary">
	                    {activeBase.description || '在这里统一管理原文、切片、引用和知识图谱'}
	                    {activeBase.graph
	                      ? ` · 图谱包含 ${activeBase.graph.nodes.length} 个实体、${activeBase.graph.edges.length} 条关系和 ${activeBase.graph.facts.length} 条事实`
	                      : ''}
	                  </Typography.Text>
                  <div className="knowledge-source-tags">
                    <Tag color={getSourceTagColor(activeBase.source)}>
                      {getSourceLabel(activeBase.source)}
                    </Tag>
                    <Tag>{activeBase.source === 'builtin' ? '升级合并前保留系统来源' : '保存在用户工作区数据'}</Tag>
                  </div>
                </div>
                <div className="knowledge-files-header__actions">
                  <input
                    ref={fileInputRef}
                    hidden
                    multiple
                    type="file"
                    accept=".txt,.md,.json,.csv,.pdf,.docx,.pptx,.xlsx,.xls,.epub,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,text/plain,text/markdown,application/json,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,image/*"
                    onChange={(event) => void handleUpload(event)}
                  />
                  <Button
                    icon={<ApartmentOutlined />}
                    disabled={!hasGraphContent}
                    onClick={() => setIsGraphOpen(true)}
                  >
                    查看知识图谱
                  </Button>
                  <Button
                    loading={isIndexing}
                    icon={<SyncOutlined />}
                    disabled={activeFiles.length === 0}
                    onClick={() => void handleRebuildGraph()}
                  >
                    重建知识图谱
                  </Button>
                  <Button
                    type="primary"
                    icon={<UploadOutlined />}
                    disabled={isIndexing || !knowledgeReady}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    导入资产
                  </Button>
                </div>
              </div>
              {!knowledgeReady && (
                <Alert
                  type="warning"
                  showIcon
                  className="knowledge-readiness-alert"
                  message="知识尚未就绪"
                  description={
                    <Space direction="vertical" size={4}>
                      <span>{knowledgeReadinessMessage}</span>
                      <span>完成后再导入资产，系统会保存原文、抽取切片，并生成可引用的知识图谱。</span>
                    </Space>
                  }
                />
              )}
              {knowledgeReady && (
                <Alert
                  type="success"
                  showIcon
                  className="knowledge-readiness-alert"
                  message="导入准备已完成"
                  description={
                    <Space direction="vertical" size={4}>
                      <span>工作目录：{settings.defaultWorkingDirectory}</span>
	                      <span>
	                        抽取模型：{indexingProvider?.name} · {settings.defaultModel}
	                      </span>
	                      <span>导入后会先保存原始文件，再解析正文、生成切片和知识图谱。</span>
                      <span>
                        持久化：原始文件、切片、图谱和引用来源会保存到工作目录；当前运行状态：解析进度、临时预览和错误提示只用于本次导入过程。
                      </span>
	                    </Space>
	                  }
	                />
              )}

              <div
                className={
                  activeFiles.length
                    ? 'knowledge-file-list'
                    : 'knowledge-file-list knowledge-file-list--empty'
                }
              >
                {activeFiles.length ? (
                  activeFiles.map((file) => {
                    const status = statusPresentation(file)
                    const isProcessing = PROCESSING_STATUSES.has(
                      file.knowledgeStatus ?? ''
                    )
                    return (
                      <article key={file.id} className="knowledge-file-item">
                        <button
                          type="button"
                          className="knowledge-file-item__main"
                          onClick={() => setPreviewFile(file)}
                        >
                          <span className="knowledge-file-item__icon">
                            {file.mimeType.startsWith('image/') ? (
                              <FileImageOutlined />
                            ) : (
                              <FileTextOutlined />
                            )}
                          </span>
                          <span className="knowledge-file-item__content">
                            <span className="knowledge-file-item__title-row">
                              <strong>{file.name}</strong>
                              <Tag color={status.color} icon={status.icon}>
                                {status.label}
                              </Tag>
                            </span>
                            <small>
                              {formatFileSize(file.size)} · 导入于{' '}
                              {new Date(file.uploadedAt).toLocaleDateString()}
                              {isProcessing
                                ? ` · ${status.label} ${file.knowledgeProgress ?? 0}%`
                                : ''}
                            </small>
                            {file.originalRelativePath && (
                              <small className="knowledge-file-item__path">
                                保存位置：{file.originalRelativePath}
                              </small>
                            )}
                            {isProcessing && (
                              <Progress
                                percent={file.knowledgeProgress ?? 0}
                                size="small"
                                status="active"
                              />
                            )}
                            {file.knowledgeStatus === 'failed' && (
                              <small className="knowledge-file-item__error">
                                失败原因：{file.knowledgeError || '未记录失败原因'}
                              </small>
                            )}
                          </span>
                        </button>
                        <div className="knowledge-file-item__actions">
                          {file.knowledgeStatus === 'failed' && (
                            <Button type="text" danger onClick={() => setFailureFile(file)}>
                              查看原因
                            </Button>
                          )}
                          <Button
                            type="text"
                            icon={<RedoOutlined />}
                            disabled={isProcessing}
                            onClick={() =>
                              void startExtraction(
                                file,
                                removeFileFromGraph(activeBase.graph, file.id)
                              )
                            }
                          >
                            重新生成
                          </Button>
                          <Button type="text" onClick={() => setPreviewFile(file)}>
                            预览
                          </Button>
                          <Popconfirm
                            title="移出资产库"
                            description="该资产、切片和图谱线索会从当前资产库移除。"
                            okText="移出"
                            cancelText="取消"
                            onConfirm={() =>
                              dispatch(
                                removeFileFromKnowledgeBase({
                                  knowledgeBaseId: activeBase.id,
                                  fileId: file.id
                                })
                              )
                            }
                          >
                            <Button
                              type="text"
                              danger
                              icon={<DeleteOutlined />}
                              aria-label="移出资产"
                            />
                          </Popconfirm>
                        </div>
                      </article>
                    )
                  })
                ) : (
                  <Empty
                    className="knowledge-files-empty"
                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                    description="这个资产库还没有内容"
                  >
                      <Button
                        icon={<UploadOutlined />}
                        disabled={!knowledgeReady}
                        onClick={() => fileInputRef.current?.click()}
                      >
                        导入第一个资产
                      </Button>
                  </Empty>
                )}
              </div>
            </>
          ) : (
            <Empty className="knowledge-files-empty" description="新建或选择一个资产库" />
          )}
        </Card>
      </section>

      <Modal
        title="新建资产库"
        open={isCreateOpen}
        okText="创建"
        cancelText="取消"
        onOk={() => void handleCreate()}
        onCancel={() => {
          setIsCreateOpen(false)
          form.resetFields()
        }}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="名称"
            name="name"
            rules={[
              { required: true, whitespace: true, message: '请输入资产库名称' },
              { max: 40, message: '名称不能超过 40 个字符' }
            ]}
          >
            <Input autoFocus placeholder="例如：产品资料库" />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 5 }}
              maxLength={160}
              showCount
              placeholder="说明这个资产库收录什么内容"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        width={1180}
        footer={null}
        title={`${activeBase?.name ?? '资产库'} 知识图谱`}
        open={isGraphOpen}
        onCancel={() => setIsGraphOpen(false)}
      >
        {activeBase?.graph && hasGraphContent ? (
          <Tabs
            defaultActiveKey="visual"
            items={[
              {
                key: 'visual',
                label: '图像图谱',
                children: <KnowledgeGraphVisual graph={activeBase.graph} />
              },
              {
                key: 'cards',
                label: '卡片图谱',
                children: (
                  <div className="knowledge-graph-viewer">
                    <div className="knowledge-graph-stats">
                      <span>
                        <strong>{activeBase.graph.nodes.length}</strong>
                        <small>实体</small>
                      </span>
                      <span>
                        <strong>{activeBase.graph.edges.length}</strong>
                        <small>关系</small>
                      </span>
                      <span>
                        <strong>{activeBase.graph.facts.length}</strong>
                        <small>事实</small>
                      </span>
                    </div>

                    <div className="knowledge-graph-columns">
                      <section className="knowledge-graph-section">
                        <Typography.Title level={5}>实体</Typography.Title>
                        <div className="knowledge-graph-list">
                          {activeBase.graph.nodes.map((node) => (
                            <article key={node.id} className="knowledge-graph-item">
                              <div className="knowledge-graph-item__title">
                                <strong>{node.name}</strong>
                                <Tag>{node.type}</Tag>
                              </div>
                              {node.description && <p>{node.description}</p>}
                              {node.aliases.length > 0 && (
                                <small>别名：{node.aliases.join('、')}</small>
                              )}
                              <small>
                                来源：{node.sourceFileIds.length} 个资产 ·{' '}
                                {node.sourceChunkIds.length} 个切片
                              </small>
                            </article>
                          ))}
                        </div>
                      </section>

                      <section className="knowledge-graph-section">
                        <Typography.Title level={5}>关系</Typography.Title>
                        {activeBase.graph.edges.length > 0 ? (
                          <div className="knowledge-graph-list">
                            {activeBase.graph.edges.map((edge) => (
                              <article key={edge.id} className="knowledge-graph-item">
                                <div className="knowledge-graph-relation">
                                  <strong>
                                    {graphNodeNames.get(edge.sourceNodeId) ?? '未知实体'}
                                  </strong>
                                  <Tag color="blue">{edge.relation}</Tag>
                                  <strong>
                                    {graphNodeNames.get(edge.targetNodeId) ?? '未知实体'}
                                  </strong>
                                </div>
                                {edge.description && <p>{edge.description}</p>}
                                <small>
                                  置信度：{Math.round(edge.confidence * 100)}%
                                </small>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="暂无关系"
                          />
                        )}
                      </section>

                      <section className="knowledge-graph-section">
                        <Typography.Title level={5}>事实</Typography.Title>
                        {activeBase.graph.facts.length > 0 ? (
                          <div className="knowledge-graph-list">
                            {activeBase.graph.facts.map((fact) => (
                              <article key={fact.id} className="knowledge-graph-item">
                                <div className="knowledge-graph-item__title">
                                  <strong>
                                    {fact.subjectNodeId
                                      ? graphNodeNames.get(fact.subjectNodeId) ?? '未知实体'
                                      : '通用事实'}
                                  </strong>
                                  <Tag color="geekblue">{fact.predicate}</Tag>
                                </div>
                                <p>{fact.value}</p>
                                <small>
                                  置信度：{Math.round(fact.confidence * 100)}%
                                </small>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <Empty
                            image={Empty.PRESENTED_IMAGE_SIMPLE}
                            description="暂无事实"
                          />
                        )}
                      </section>
                    </div>
                  </div>
                )
              }
            ]}
          />
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无知识图谱" />
        )}
      </Modal>

      <Modal
        width={900}
        footer={null}
        title={previewFile?.name}
        open={Boolean(previewFile)}
        onCancel={() => setPreviewFile(null)}
      >
        <Tabs
          defaultActiveKey="source"
          items={[
            {
              key: 'source',
              label: '原始内容',
              children: (
                <div className="knowledge-preview">
                  {previewFile?.preview ? (
                    <img src={previewFile.preview} alt={previewFile.name} />
                  ) : previewFile?.contentText ? (
                    <pre>{previewFile.contentText}</pre>
                  ) : (
                    <Empty
                      image={Empty.PRESENTED_IMAGE_SIMPLE}
                      description="当前格式暂不支持内容预览"
                    >
                      <Typography.Text type="secondary">
                        {previewFile?.mimeType} · {formatFileSize(previewFile?.size ?? 0)}
                      </Typography.Text>
                    </Empty>
                  )}
                  {previewFile?.originalRelativePath && (
                    <Typography.Paragraph type="secondary">
                      原始文件保存位置：{previewFile.originalRelativePath}
                    </Typography.Paragraph>
                  )}
                </div>
              )
            },
            {
              key: 'chunks',
              label: `切片 ${previewChunks.length}`,
              children: previewChunks.length ? (
                <div className="knowledge-preview-list">
                  {previewChunks.map((chunk, index) => (
                    <article key={chunk.id} className="knowledge-preview-card">
                      <div>
                        <strong>{chunk.title || `切片 ${index + 1}`}</strong>
                        <Tag>{chunk.tokenCount} tokens</Tag>
                      </div>
                      {chunk.summary && <p>{chunk.summary}</p>}
                      <pre>{chunk.content}</pre>
                    </article>
                  ))}
                </div>
              ) : (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无切片" />
              )
            },
            {
              key: 'references',
              label: '引用来源',
              children: (
                <div className="knowledge-preview-list">
                  <article className="knowledge-preview-card">
                    <strong>实体</strong>
                    {previewGraphSources.nodes.length ? (
                      <Space wrap>
                        {previewGraphSources.nodes.map((node) => (
                          <Tag key={node.id}>{node.name}</Tag>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">暂无实体引用</Typography.Text>
                    )}
                  </article>
                  <article className="knowledge-preview-card">
                    <strong>关系</strong>
                    {previewGraphSources.edges.length ? (
                      <Space direction="vertical" size={6}>
                        {previewGraphSources.edges.map((edge) => (
                          <Typography.Text key={edge.id}>
                            {(graphNodeNames.get(edge.sourceNodeId) ?? edge.sourceNodeId)}
                            {' -> '}
                            {edge.relation}
                            {' -> '}
                            {(graphNodeNames.get(edge.targetNodeId) ?? edge.targetNodeId)}
                          </Typography.Text>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">暂无关系引用</Typography.Text>
                    )}
                  </article>
                  <article className="knowledge-preview-card">
                    <strong>事实</strong>
                    {previewGraphSources.facts.length ? (
                      <Space direction="vertical" size={6}>
                        {previewGraphSources.facts.map((fact) => (
                          <Typography.Text key={fact.id}>
                            {fact.predicate}：{fact.value}
                          </Typography.Text>
                        ))}
                      </Space>
                    ) : (
                      <Typography.Text type="secondary">暂无事实引用</Typography.Text>
                    )}
                  </article>
                </div>
              )
            }
          ]}
        />
      </Modal>

      <Modal
        title="知识图谱生成失败"
        open={Boolean(failureFile)}
        footer={
          <Button type="primary" onClick={() => setFailureFile(null)}>
            知道了
          </Button>
        }
        onCancel={() => setFailureFile(null)}
      >
        <Typography.Paragraph type="secondary">
          {failureFile?.name}
        </Typography.Paragraph>
        <Typography.Paragraph className="knowledge-failure-reason">
          {failureFile?.knowledgeError || '未记录失败原因。'}
        </Typography.Paragraph>
      </Modal>
    </>
  )
}
