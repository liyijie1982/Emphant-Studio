import {
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
  Button,
  Card,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Tag,
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
import type { FileRecord, KnowledgeGraph } from '@emphant/shared/types'

const PROCESSING_STATUSES = new Set(['queued', 'extracting', 'indexing'])

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

    const selectedFiles = Array.from(event.target.files ?? [])
    const indexingProvider = providers.find(
      (provider) => provider.id === settings.defaultProviderId && provider.enabled
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
            ? `${file.name} 原文件保存失败：${error.message}`
            : `${file.name} 原文件保存失败`
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
          `${pendingJobs.length} 个文件已上传，知识提取将在后台进行`
        )
      } catch (error) {
        void messageApi.error(
          error instanceof Error
            ? `文件未能保存到工作目录：${error.message}`
            : '文件未能保存到工作目录'
        )
      }

      for (const { file, bytes } of pendingJobs) {
        if (!indexingProvider) {
          dispatch(
            applyKnowledgeExtractionEvent({
              jobId: nanoid(),
              knowledgeBaseId: activeBase.id,
              fileId: file.id,
              status: 'failed',
              progress: 100,
              error: '默认 Provider 不可用，请在设置中启用后重新生成。',
              completedAt: new Date().toISOString()
            })
          )
          continue
        }
        try {
          await window.emphant.startKnowledgeExtraction({
            jobId: nanoid(),
            knowledgeBaseId: activeBase.id,
            provider: indexingProvider,
            model: settings.defaultModel,
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
    const indexingProvider = providers.find(
      (provider) => provider.id === settings.defaultProviderId && provider.enabled
    )
    if (!indexingProvider) {
      void messageApi.error('默认 Provider 不可用，无法生成知识图谱。')
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
    void messageApi.info('已提交全部文件的重新生成任务')
  }

  return (
    <>
      <section className="knowledge-workspace">
        <Card className="workspace-panel knowledge-sidebar" variant="borderless">
          <div className="knowledge-panel-header">
            <Typography.Title level={4}>知识库</Typography.Title>
            <Button
              type="text"
              className="knowledge-create-button"
              icon={<PlusOutlined />}
              aria-label="新建知识库"
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
                        {base.sourceFileIds.length} 个文件 · {base.chunkCount} 个切片
                        {base.graph
                          ? ` · ${base.graph.nodes.length} 个实体 · ${base.graph.edges.length} 条关系`
                          : ''}
                      </small>
                    </span>
                  </button>
                  <Popconfirm
                    title="删除知识库"
                    description="知识库会被删除，原始文件仍保留在文件管理中。"
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
                  knowledgeBases.length === 0 ? '还没有知识库' : '没有匹配的知识库'
                }
              >
                {knowledgeBases.length === 0 && (
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={() => setIsCreateOpen(true)}
                  >
                    新建知识库
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
                    {activeBase.description || '管理这个知识库中的文件'}
                    {activeBase.graph
                      ? ` · 图谱包含 ${activeBase.graph.nodes.length} 个实体、${activeBase.graph.edges.length} 条关系和 ${activeBase.graph.facts.length} 条事实`
                      : ''}
                  </Typography.Text>
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
                    disabled={isIndexing}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    上传文件
                  </Button>
                </div>
              </div>

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
                              {formatFileSize(file.size)} · 上传于{' '}
                              {new Date(file.uploadedAt).toLocaleDateString()}
                              {isProcessing
                                ? ` · ${status.label} ${file.knowledgeProgress ?? 0}%`
                                : ''}
                            </small>
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
                            title="移出知识库"
                            description="原文件仍会保留在文件管理中。"
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
                              aria-label="删除文件"
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
                    description="这个知识库还没有文件"
                  >
                    <Button
                      icon={<UploadOutlined />}
                      onClick={() => fileInputRef.current?.click()}
                    >
                      上传第一个文件
                    </Button>
                  </Empty>
                )}
              </div>
            </>
          ) : (
            <Empty className="knowledge-files-empty" description="新建或选择一个知识库" />
          )}
        </Card>
      </section>

      <Modal
        title="新建知识库"
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
              { required: true, whitespace: true, message: '请输入知识库名称' },
              { max: 40, message: '名称不能超过 40 个字符' }
            ]}
          >
            <Input autoFocus placeholder="例如：产品需求库" />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 5 }}
              maxLength={160}
              showCount
              placeholder="说明这个知识库收录什么内容"
            />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        width={760}
        footer={null}
        title={previewFile?.name}
        open={Boolean(previewFile)}
        onCancel={() => setPreviewFile(null)}
      >
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
        </div>
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
