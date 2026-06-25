import {
  DeleteOutlined,
  EditOutlined,
  EyeInvisibleOutlined,
  FileTextOutlined,
  PlusOutlined,
  RobotOutlined,
  SearchOutlined
} from '@ant-design/icons'
import { App, Button, Card, Dropdown, Empty, Input, Modal, Tooltip, Typography } from 'antd'
import type { MenuProps } from 'antd'
import { useEffect, useMemo, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { useAppDispatch, useAppSelector } from '@/store/hooks'
import {
  createSystemNote,
  deleteSystemNote,
  selectActiveSystemNote,
  selectSystemNotes,
  setActiveSystemNote,
  updateSystemNote
} from '@/store/workbenchSlice'

export const NotesPage = () => {
  const dispatch = useAppDispatch()
  const { modal, message } = App.useApp()
  const notes = useAppSelector(selectSystemNotes)
  const activeNote = useAppSelector(selectActiveSystemNote)
  const [editorVisible, setEditorVisible] = useState(false)
  const [renamingNoteId, setRenamingNoteId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [query, setQuery] = useState('')
  const filteredNotes = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()
    if (!normalizedQuery) {
      return notes
    }

    return notes.filter((note) =>
      [note.title, note.assistantName ?? '手动创建', note.content].some((value) =>
        value.toLowerCase().includes(normalizedQuery)
      )
    )
  }, [notes, query])

  useEffect(() => {
    if (!activeNote) {
      setEditorVisible(false)
    }
  }, [activeNote])

  const handleCreateNote = () => {
    dispatch(createSystemNote())
    setEditorVisible(true)
  }

  const handleSelectNote = (noteId: string) => {
    dispatch(setActiveSystemNote(noteId))
    setEditorVisible(false)
  }

  const openRenameModal = (noteId: string) => {
    const note = notes.find((item) => item.id === noteId)
    if (!note) {
      return
    }
    setRenamingNoteId(noteId)
    setRenameValue(note.title)
  }

  const handleRename = () => {
    const title = renameValue.trim()
    if (!renamingNoteId || !title) {
      return
    }
    dispatch(updateSystemNote({ noteId: renamingNoteId, patch: { title } }))
    setRenamingNoteId(null)
    void message.success('笔记已重命名')
  }

  const confirmDelete = (noteId: string) => {
    const note = notes.find((item) => item.id === noteId)
    if (!note) {
      return
    }
    modal.confirm({
      title: `删除笔记“${note.title}”？`,
      content: '删除后无法恢复。',
      okText: '删除',
      okButtonProps: { danger: true },
      cancelText: '取消',
      onOk: () => {
        dispatch(deleteSystemNote(noteId))
        void message.success('笔记已删除')
      }
    })
  }

  const getNoteMenu = (noteId: string): MenuProps => ({
    items: [
      {
        key: 'rename',
        icon: <EditOutlined />,
        label: '重命名'
      },
      {
        type: 'divider'
      },
      {
        key: 'delete',
        icon: <DeleteOutlined />,
        label: '删除',
        danger: true
      }
    ],
    onClick: ({ key }) => {
      if (key === 'rename') {
        openRenameModal(noteId)
      } else if (key === 'delete') {
        confirmDelete(noteId)
      }
    }
  })

  return (
    <section className="notes-layout">
      <Card className="workspace-panel notes-sidebar" bordered={false}>
        <div className="panel-header notes-sidebar__header">
          <Typography.Title level={4}>笔记</Typography.Title>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={handleCreateNote}
            aria-label="新建笔记"
          />
        </div>

        <Input
          allowClear
          value={query}
          prefix={<SearchOutlined />}
          placeholder="搜索标题、来源或内容"
          onChange={(event) => setQuery(event.target.value)}
          className="sidebar-list-search"
        />

        <div className="notes-list">
          {filteredNotes.length ? (
            filteredNotes.map((note) => (
              <Dropdown
                key={note.id}
                menu={getNoteMenu(note.id)}
                trigger={['contextMenu']}
              >
                <button
                  type="button"
                  className={
                    note.id === activeNote?.id
                      ? 'notes-list__item is-active'
                      : 'notes-list__item'
                  }
                  onClick={() => handleSelectNote(note.id)}
                  onContextMenu={() => dispatch(setActiveSystemNote(note.id))}
                >
                  <FileTextOutlined />
                  <span>
                    <strong>{note.title}</strong>
                    <small>
                      {note.assistantName ?? '手动创建'} ·{' '}
                      {new Date(note.updatedAt).toLocaleString()}
                    </small>
                  </span>
                </button>
              </Dropdown>
            ))
          ) : (
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={notes.length === 0 ? '还没有笔记' : '没有匹配的笔记'}
            >
              {notes.length === 0 && (
                <Button type="primary" onClick={handleCreateNote}>
                  新建笔记
                </Button>
              )}
            </Empty>
          )}
        </div>
      </Card>

      <Card className="workspace-panel notes-editor" bordered={false}>
        {activeNote ? (
          <>
            <div className="notes-editor__header">
              <Input
                className="notes-editor__title"
                value={activeNote.title}
                aria-label="笔记标题"
                onChange={(event) =>
                  dispatch(
                    updateSystemNote({
                      noteId: activeNote.id,
                      patch: { title: event.target.value }
                    })
                  )
                }
              />
              <div className="notes-editor__meta">
                <Typography.Text type="secondary">
                  {activeNote.assistantName ? (
                    <>
                      <RobotOutlined /> {activeNote.assistantName}
                    </>
                  ) : (
                    '手动创建'
                  )}{' '}
                  · 自动保存
                </Typography.Text>
                <Tooltip title={editorVisible ? '隐藏编辑区域' : '编辑笔记'}>
                  <Button
                    type="text"
                    size="small"
                    className="notes-editor__toggle"
                    icon={editorVisible ? <EyeInvisibleOutlined /> : <EditOutlined />}
                    aria-label={editorVisible ? '隐藏编辑区域' : '编辑笔记'}
                    onClick={() => setEditorVisible((visible) => !visible)}
                  />
                </Tooltip>
              </div>
            </div>
            <div
              className={
                editorVisible
                  ? 'notes-editor__workspace'
                  : 'notes-editor__workspace is-preview-only'
              }
            >
              {editorVisible && (
                <div className="notes-editor__pane">
                  <Typography.Text className="notes-editor__pane-label" type="secondary">
                    Markdown
                  </Typography.Text>
                  <Input.TextArea
                    className="notes-editor__content"
                    value={activeNote.content}
                    aria-label="笔记内容"
                    placeholder="使用 Markdown 编写笔记…"
                    onChange={(event) =>
                      dispatch(
                        updateSystemNote({
                          noteId: activeNote.id,
                          patch: { content: event.target.value }
                        })
                      )
                    }
                    autoSize={false}
                  />
                </div>
              )}
              <div className="notes-editor__pane notes-editor__preview-pane">
                <Typography.Text className="notes-editor__pane-label" type="secondary">
                  预览
                </Typography.Text>
                <div className="notes-editor__preview message-markdown">
                  {activeNote.content.trim() ? (
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      rehypePlugins={[rehypeHighlight]}
                    >
                      {activeNote.content}
                    </ReactMarkdown>
                  ) : (
                    <Typography.Text type="secondary">
                      Markdown 预览将显示在这里
                    </Typography.Text>
                  )}
                </div>
              </div>
            </div>
            <div className="notes-editor__status">
              <span>{activeNote.content.length} 字符</span>
              <span>更新于 {new Date(activeNote.updatedAt).toLocaleString()}</span>
            </div>
          </>
        ) : (
          <Empty description="选择或新建一条笔记开始编辑" />
        )}
      </Card>

      <Modal
        title="重命名笔记"
        open={renamingNoteId !== null}
        okText="保存"
        cancelText="取消"
        okButtonProps={{ disabled: !renameValue.trim() }}
        onOk={handleRename}
        onCancel={() => setRenamingNoteId(null)}
        destroyOnHidden
      >
        <Input
          autoFocus
          value={renameValue}
          placeholder="输入笔记名称"
          onChange={(event) => setRenameValue(event.target.value)}
          onPressEnter={handleRename}
        />
      </Modal>
    </section>
  )
}
