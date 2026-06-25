import { nanoid } from '@reduxjs/toolkit'
import type { FileRecord, KnowledgeBase, KnowledgeChunk } from '@emphant/shared/types'

const tokenize = (value: string) => {
  const normalized = value.toLowerCase()
  const tokens = normalized
    .split(/[\s,.;:!?()\-_/\\\u3000，。；：！？、“”‘’《》【】]+/)
    .filter(Boolean)
  const chineseSegments = normalized.match(/[\u3400-\u9fff]+/g) ?? []

  for (const segment of chineseSegments) {
    if (segment.length <= 2) {
      tokens.push(segment)
      continue
    }

    for (let index = 0; index < segment.length - 1; index += 1) {
      tokens.push(segment.slice(index, index + 2))
    }
  }

  return [...new Set(tokens.filter((token) => token.length > 1))]
}

const chunkText = (text: string, sourceFileId?: string): KnowledgeChunk[] => {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) {
    return []
  }

  const chunks: KnowledgeChunk[] = []
  const chunkSize = 80

  for (let index = 0; index < words.length; index += chunkSize) {
    const slice = words.slice(index, index + chunkSize)
    chunks.push({
      id: nanoid(),
      sourceFileId,
      content: slice.join(' '),
      tokenCount: slice.length
    })
  }

  return chunks
}

export const buildKnowledgeContent = (
  sourceFileIds: string[],
  files: FileRecord[],
  fallbackDescription: string
) => {
  const text = files
    .filter((file) => sourceFileIds.includes(file.id))
    .map((file) => `${file.name}\n${file.contentText ?? ''}`)
    .join('\n\n')
    .trim()

  return text || fallbackDescription
}

export const buildKnowledgeChunks = ({
  sourceFileIds,
  files,
  fallbackDescription
}: {
  sourceFileIds: string[]
  files: FileRecord[]
  fallbackDescription: string
}) => {
  const matchedFiles = files.filter((file) => sourceFileIds.includes(file.id))
  const fileChunks = matchedFiles.flatMap((file) =>
    chunkText(`${file.name}\n${file.contentText ?? ''}`, file.id)
  )

  return fileChunks.length > 0 ? fileChunks : chunkText(fallbackDescription)
}

export const searchKnowledgeBases = ({
  prompt,
  bases,
  files
}: {
  prompt: string
  bases: KnowledgeBase[]
  files: FileRecord[]
}) => {
  const tokens = tokenize(prompt)

  return bases
    .flatMap((base) => {
      const chunks =
        base.chunks && base.chunks.length > 0
          ? base.chunks
          : buildKnowledgeChunks({
              sourceFileIds: base.sourceFileIds,
              files,
              fallbackDescription: base.indexedContent || base.description
            })

      const graph = base.graph
      const matchedNodeIds = new Set(
        (graph?.nodes ?? [])
          .filter((node) => {
            const corpus = [
              node.name,
              ...node.aliases,
              node.type,
              node.description ?? ''
            ]
              .join(' ')
              .toLowerCase()
            return tokens.some((token) => corpus.includes(token))
          })
          .map((node) => node.id)
      )
      const relevantEdges = (graph?.edges ?? []).filter((edge) => {
        const corpus = `${edge.relation} ${edge.description ?? ''}`.toLowerCase()
        return (
          matchedNodeIds.has(edge.sourceNodeId) ||
          matchedNodeIds.has(edge.targetNodeId) ||
          tokens.some((token) => corpus.includes(token))
        )
      })
      for (const edge of relevantEdges) {
        matchedNodeIds.add(edge.sourceNodeId)
        matchedNodeIds.add(edge.targetNodeId)
      }
      const relevantFacts = (graph?.facts ?? []).filter((fact) => {
        const corpus = `${fact.predicate} ${fact.value}`.toLowerCase()
        return (
          (fact.subjectNodeId ? matchedNodeIds.has(fact.subjectNodeId) : false) ||
          tokens.some((token) => corpus.includes(token))
        )
      })
      const graphChunkIds = new Set([
        ...(graph?.nodes ?? [])
          .filter((node) => matchedNodeIds.has(node.id))
          .flatMap((node) => node.sourceChunkIds),
        ...relevantEdges.flatMap((edge) => edge.sourceChunkIds),
        ...relevantFacts.flatMap((fact) => fact.sourceChunkIds)
      ])
      const nodeName = new Map((graph?.nodes ?? []).map((node) => [node.id, node.name]))
      const graphEvidence = [
        ...relevantEdges.slice(0, 5).map(
          (edge) =>
            `${nodeName.get(edge.sourceNodeId) ?? '未知实体'} —${edge.relation}→ ${
              nodeName.get(edge.targetNodeId) ?? '未知实体'
            }`
        ),
        ...relevantFacts.slice(0, 5).map((fact) =>
          `${fact.subjectNodeId ? `${nodeName.get(fact.subjectNodeId) ?? '未知实体'} ` : ''}${
            fact.predicate
          }：${fact.value}`
        )
      ]

      return chunks.map((chunk) => {
        const corpus = [
          chunk.title ?? '',
          chunk.summary ?? '',
          ...(chunk.keywords ?? []),
          chunk.content
        ]
          .join(' ')
          .toLowerCase()
        const matchedTokens = tokens.filter((token) => corpus.includes(token))
        const lexicalScore = matchedTokens.reduce(
          (sum, token) => sum + Math.min(token.length, 6),
          0
        )
        const graphScore =
          graphChunkIds.has(chunk.id) ||
          chunk.entityIds?.some((entityId) => matchedNodeIds.has(entityId))
            ? 12
            : 0
        return { base, chunk, score: lexicalScore + graphScore, graphEvidence }
      })
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((item) => {
      const file = files.find((candidate) => candidate.id === item.chunk.sourceFileId)

      return {
        base: item.base,
        chunk: item.chunk,
        file,
        excerpt: item.chunk.content.slice(0, 500),
        graphEvidence: item.graphEvidence
      }
    })
}
