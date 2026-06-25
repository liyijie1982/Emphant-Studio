import { nanoid } from '@reduxjs/toolkit'
import type {
  Assistant,
  FileRecord,
  KnowledgeBase,
  McpTool,
  MessageBlock,
  ProviderConfig
} from '@emphant/shared/types'

const createBlock = (
  type: MessageBlock['type'],
  content: string,
  title?: string,
  meta?: Record<string, string>
): MessageBlock => ({
  id: nanoid(),
  type,
  title,
  content,
  meta,
  status: 'done'
})

const summarizeKnowledge = (base: KnowledgeBase, files: FileRecord[]) => {
  const attachedFiles = files.filter((file) => base.sourceFileIds.includes(file.id))
  const sample = attachedFiles
    .map((file) => file.contentText || `${file.name} (${file.mimeType})`)
    .join(' ')
    .slice(0, 180)

  return sample || `${base.name} 已建立 ${base.chunkCount} 个切片，可用于补充上下文。`
}

export const composeAssistantBlocks = ({
  prompt,
  assistant,
  provider,
  knowledgeBases,
  tools,
  files
}: {
  prompt: string
  assistant: Assistant
  provider?: ProviderConfig
  knowledgeBases: KnowledgeBase[]
  tools: McpTool[]
  files: FileRecord[]
}): MessageBlock[] => {
  const blocks: MessageBlock[] = []
  const normalizedPrompt = prompt.toLowerCase()

  blocks.push(
    createBlock(
      'text',
      `${assistant.name} 正在使用 ${assistant.model}${provider ? `（${provider.name}）` : ''} 响应你的请求。当前工作台已经能根据已挂载知识库、MCP 工具和文件资源组织增强回复。`
    )
  )

  const matchedKnowledge = knowledgeBases.filter(
    (base) =>
      assistant.knowledgeBaseIds.includes(base.id) &&
      (normalizedPrompt.includes('知识') ||
        normalizedPrompt.includes('文档') ||
        normalizedPrompt.includes('需求') ||
        normalizedPrompt.includes(base.name.toLowerCase()))
  )

  matchedKnowledge.forEach((base) => {
    const sourceFile = files.find((file) => base.sourceFileIds.includes(file.id))
    const sourceFileName = sourceFile?.name ?? '知识库内容'

    blocks.push(
      createBlock(
        'reference',
        summarizeKnowledge(base, files),
        `引用：${base.name}・${sourceFileName}`,
        {
          chunks: String(base.chunkCount),
          status: base.status,
          knowledgeBaseName: base.name,
          fileName: sourceFileName
        }
      )
    )
  })

  const activeTools = tools.filter((tool) => assistant.enabledToolIds.includes(tool.id))
  activeTools.forEach((tool) => {
    const shouldUseTool =
      normalizedPrompt.includes('搜索') ||
      normalizedPrompt.includes('查找') ||
      normalizedPrompt.includes('文件') ||
      normalizedPrompt.includes(tool.name.toLowerCase())

    if (shouldUseTool) {
      blocks.push(
        createBlock(
          'tool',
          `${tool.serverName} / ${tool.name} 已参与本轮推理，当前为桌面原型模拟执行。`,
          `工具调用：${tool.name}`,
          { category: tool.category }
        )
      )
    }
  })

  const relatedFiles = files.filter(
    (file) =>
      normalizedPrompt.includes(file.name.toLowerCase()) ||
      normalizedPrompt.includes('附件') ||
      normalizedPrompt.includes('文件')
  )

  relatedFiles.slice(0, 2).forEach((file) => {
    blocks.push(
      createBlock(
        'file',
        file.contentText?.slice(0, 180) || `${file.name} 已可在文件工作区预览。`,
        `文件上下文：${file.name}`,
        { mimeType: file.mimeType, size: `${file.size}` }
      )
    )
  })

  if (blocks.length === 1) {
    blocks[0] = createBlock(
      'text',
      `${assistant.name} 已收到你的输入：“${prompt}”。当前没有触发额外知识引用或工具调用，但工作台底层已经具备这些扩展位。`
    )
  }

  return blocks
}
