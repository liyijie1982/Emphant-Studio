import { nanoid } from '@reduxjs/toolkit'
import { Button, Card, Input, List, Space, Tag, Typography } from 'antd'
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import { selectFiles, uploadFile } from '@/store/workbenchSlice'
import type { WorkspaceFileMatch } from '@emphant/shared/types'

const readFilePreview = async (file: File) => {
  const isText = file.type.startsWith('text/') || file.name.endsWith('.md')
  const preview = await new Promise<string | undefined>((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined)
    if (isText) {
      reader.readAsText(file)
    } else if (file.type.startsWith('image/')) {
      reader.readAsDataURL(file)
    } else {
      resolve(undefined)
    }
  })

  if (isText || file.type.startsWith('image/')) {
    return {
      preview: file.type.startsWith('image/') ? preview : undefined,
      contentText: isText ? preview : undefined,
      extractedBy: isText ? ('native' as const) : undefined
    }
  }

  const extraction = await window.emphant.extractDocument({
    name: file.name,
    mimeType: file.type || 'application/octet-stream',
    bytes: new Uint8Array(await file.arrayBuffer())
  })
  return {
    contentText: extraction.contentText,
    extractedBy: extraction.extractedBy,
    extractionWarning: extraction.warning
  }
}

export const FilesPage = () => {
  const dispatch = useAppDispatch()
  const files = useAppSelector(selectFiles)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [filter, setFilter] = useState('')
  const [workspaceQuery, setWorkspaceQuery] = useState('md')
  const [workspaceMatches, setWorkspaceMatches] = useState<WorkspaceFileMatch[]>([])
  const [workspaceStatus, setWorkspaceStatus] = useState('')
  const [isDragging, setIsDragging] = useState(false)

  const visibleFiles = files.filter((file) =>
    file.name.toLowerCase().includes(filter.trim().toLowerCase())
  )

  const importBrowserFiles = async (selectedFiles: File[]) => {
    for (const file of selectedFiles) {
      const payload = await readFilePreview(file)
      dispatch(
        uploadFile({
          id: nanoid(),
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          uploadedAt: new Date().toISOString(),
          ...payload
        })
      )
    }
  }

  const handleFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? [])
    await importBrowserFiles(selectedFiles)

    if (fileInputRef.current) {
      fileInputRef.current.value = ''
    }
  }

  const handleWorkspaceSearch = async () => {
    const query = workspaceQuery.trim()
    if (!query) {
      return
    }

    setWorkspaceStatus('正在扫描工作区...')
    try {
      const matches = await window.emphant.scanWorkspaceFiles(query, 8)
      setWorkspaceMatches(matches)
      setWorkspaceStatus(matches.length > 0 ? `命中 ${matches.length} 个文件` : '没有命中文件')
    } catch {
      setWorkspaceStatus('工作区扫描失败')
    }
  }

  const handleImportWorkspaceFile = async (path: string) => {
    const payload = await window.emphant.readWorkspaceFile(path)
    dispatch(
      uploadFile({
        id: nanoid(),
        name: payload.name,
        mimeType: payload.mimeType,
        size: payload.size,
          uploadedAt: new Date().toISOString(),
          contentText: payload.contentText,
          extractedBy: payload.extractedBy,
          extractionWarning: payload.extractionWarning
      })
    )
  }

  const handleDrop = async (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    setIsDragging(false)
    const selectedFiles = Array.from(event.dataTransfer.files ?? [])
    await importBrowserFiles(selectedFiles)
  }

  return (
    <Card
      className={isDragging ? 'workspace-panel page-panel is-dragging' : 'workspace-panel page-panel'}
      bordered={false}
      onDragEnter={(event) => {
        event.preventDefault()
        setIsDragging(true)
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault()
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return
        }
        setIsDragging(false)
      }}
      onDrop={(event) => void handleDrop(event)}
    >
      <Space className="page-toolbar" wrap>
        <div>
          <Typography.Title level={3}>文件管理</Typography.Title>
          <Typography.Paragraph type="secondary">
            已支持本地上传、拖拽导入、图片预览和文本内容入库，后续可以继续接 OCR、PDF 与 Office 解析。
          </Typography.Paragraph>
        </div>
        <Space>
          <Input
            placeholder="搜索文件名"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
          <input
            ref={fileInputRef}
            hidden
            multiple
            type="file"
            onChange={handleFileUpload}
          />
          <Button type="primary" onClick={() => fileInputRef.current?.click()}>
            上传文件
          </Button>
        </Space>
      </Space>

      <Card className="workspace-panel workspace-subpanel" bordered={false}>
        <Space wrap className="fill-column workspace-import-bar">
          <Input
            placeholder="搜索工作区文件，例如 md / prd / design"
            value={workspaceQuery}
            onChange={(event) => setWorkspaceQuery(event.target.value)}
          />
          <Button onClick={() => void handleWorkspaceSearch()}>扫描工作区</Button>
          <Typography.Text type="secondary">{workspaceStatus}</Typography.Text>
        </Space>
        <List
          size="small"
          dataSource={workspaceMatches}
          locale={{ emptyText: '还没有扫描结果' }}
          renderItem={(match) => (
            <List.Item
              actions={[
                <Button
                  key={match.path}
                  type="link"
                  onClick={() => void handleImportWorkspaceFile(match.path)}
                >
                  导入
                </Button>
              ]}
            >
              <List.Item.Meta
                title={match.path.split('/').pop()}
                description={`${match.path} · ${Math.max(1, Math.round(match.size / 1024))} KB`}
              />
            </List.Item>
          )}
        />
      </Card>

      <List
        dataSource={visibleFiles}
        renderItem={(file) => (
          <List.Item className="file-list-item">
            <List.Item.Meta
              title={file.name}
              description={`${file.mimeType} · ${Math.round(file.size / 1024) || 1} KB`}
            />
            <Tag>{new Date(file.uploadedAt).toLocaleString()}</Tag>
            {file.preview && (
              <img className="file-preview" src={file.preview} alt={file.name} />
            )}
            {file.contentText && (
              <Typography.Paragraph className="file-text-preview">
                {file.contentText.slice(0, 220)}
              </Typography.Paragraph>
            )}
            {file.extractedBy === 'markitdown' && <Tag color="blue">MarkItDown</Tag>}
            {file.extractionWarning && <Tag color="orange">{file.extractionWarning}</Tag>}
          </List.Item>
        )}
      />
    </Card>
  )
}
