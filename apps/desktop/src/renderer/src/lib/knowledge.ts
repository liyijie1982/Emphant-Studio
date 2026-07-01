import { nanoid } from '@reduxjs/toolkit'
import type {
  FileRecord,
  KnowledgeBase,
  KnowledgeChunk,
  KnowledgeGraph,
  ProviderConfig
} from '@emphant/shared/types'

const tokenize = (value: string) => {
  const normalized = value.toLowerCase()
  const tokens = normalized
    .split(/[\s,.;:!?()\-_/\\\u3000，。；：！？、“”‘’《》【】]+/)
    .filter(Boolean)
  const chineseSegments = normalized.match(/[\u3400-\u9fff]+/g) ?? []

  for (const segment of chineseSegments) {
    tokens.push(segment)
    if (segment.length <= 2) {
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

  if (words.length <= 2 && text.length > 600) {
    const chunkChars = 900
    for (let index = 0; index < text.length; index += chunkChars) {
      const content = text.slice(index, index + chunkChars).trim()
      if (content) {
        chunks.push({
          id: nanoid(),
          sourceFileId,
          content,
          tokenCount: Math.ceil(content.length / 2)
        })
      }
    }
    return chunks
  }

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

const unique = (items: string[]) => [...new Set(items.filter(Boolean))]

const cosineSimilarity = (left: number[], right: number[]) => {
  const length = Math.min(left.length, right.length)
  if (length === 0) return 0

  let dot = 0
  let leftNorm = 0
  let rightNorm = 0
  for (let index = 0; index < length; index += 1) {
    dot += left[index] * right[index]
    leftNorm += left[index] * left[index]
    rightNorm += right[index] * right[index]
  }

  if (leftNorm === 0 || rightNorm === 0) return 0
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm))
}

const buildGraphEvidence = ({
  graph,
  chunk,
  matchedNodeIds,
  relevantEdges,
  relevantFacts,
  fallback = false
}: {
  graph: KnowledgeGraph | undefined
  chunk: KnowledgeChunk
  matchedNodeIds: Set<string>
  relevantEdges: NonNullable<KnowledgeGraph['edges']>
  relevantFacts: NonNullable<KnowledgeGraph['facts']>
  fallback?: boolean
}) => {
  if (!graph) return []

  const nodeName = new Map(graph.nodes.map((node) => [node.id, node.name]))
  const chunkNodeIds = new Set([
    ...(chunk.entityIds ?? []),
    ...graph.nodes
      .filter((node) => node.sourceChunkIds.includes(chunk.id))
      .map((node) => node.id)
  ])
  const evidenceNodeIds = new Set([...matchedNodeIds, ...chunkNodeIds])
  const edgeEvidence = [
    ...relevantEdges,
    ...graph.edges.filter(
      (edge) =>
        edge.sourceChunkIds.includes(chunk.id) ||
        evidenceNodeIds.has(edge.sourceNodeId) ||
        evidenceNodeIds.has(edge.targetNodeId)
    )
  ]
  const factEvidence = [
    ...relevantFacts,
    ...graph.facts.filter(
      (fact) =>
        fact.sourceChunkIds.includes(chunk.id) ||
        (fact.subjectNodeId ? evidenceNodeIds.has(fact.subjectNodeId) : false)
    )
  ]

  const edgeLines = edgeEvidence.slice(0, fallback ? 3 : 5).map(
    (edge) =>
      `${nodeName.get(edge.sourceNodeId) ?? '未知实体'} —${edge.relation}→ ${
        nodeName.get(edge.targetNodeId) ?? '未知实体'
      }`
  )
  const factLines = factEvidence.slice(0, fallback ? 3 : 5).map((fact) =>
    `${fact.subjectNodeId ? `${nodeName.get(fact.subjectNodeId) ?? '未知实体'} ` : ''}${
      fact.predicate
    }：${fact.value}`
  )

  return unique([...edgeLines, ...factLines]).slice(0, fallback ? 5 : 8)
}

export const searchKnowledgeBases = async ({
  prompt,
  bases,
  files,
  embeddingProvider,
  embeddingModel,
  rerankProvider,
  rerankModel
}: {
  prompt: string
  bases: KnowledgeBase[]
  files: FileRecord[]
  embeddingProvider?: ProviderConfig
  embeddingModel?: string
  rerankProvider?: ProviderConfig
  rerankModel?: string
}) => {
  const tokens = tokenize(prompt)
  let promptEmbedding: number[] | undefined

  if (embeddingProvider && embeddingModel) {
    try {
      promptEmbedding = (await window.emphant.embedTexts(embeddingProvider, embeddingModel, [
        prompt
      ]))[0]
    } catch {
      promptEmbedding = undefined
    }
  }

  const scoredItems = bases.flatMap((base) => {
    const chunks =
      base.chunks && base.chunks.length > 0
        ? base.chunks
        : buildKnowledgeChunks({
            sourceFileIds: base.sourceFileIds,
            files,
            fallbackDescription: base.indexedContent || base.description
          })

    const graph = base.graph
    const baseCorpus = [base.name, base.description, base.indexedContent ?? '']
      .join(' ')
      .toLowerCase()
    const baseScore = tokens.some((token) => baseCorpus.includes(token)) ? 6 : 0
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
        const semanticScore =
          promptEmbedding && chunk.embedding
            ? Math.max(0, cosineSimilarity(promptEmbedding, chunk.embedding)) * 18
            : 0
        const graphEvidence = buildGraphEvidence({
          graph,
          chunk,
          matchedNodeIds,
          relevantEdges,
          relevantFacts,
          fallback: lexicalScore + graphScore + semanticScore === 0
        })
        return {
          base,
          chunk,
          score: baseScore + lexicalScore + graphScore + semanticScore,
          graphEvidence
        }
      })
    })

  let matchedItems = scoredItems
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)

  if (rerankProvider && rerankModel && matchedItems.length > 1) {
    const candidates = matchedItems.slice(0, 12)
    try {
      const scores = await window.emphant.rerankDocuments(
        rerankProvider,
        rerankModel,
        prompt,
        candidates.map((item) => item.chunk.content)
      )
      matchedItems = [
        ...candidates.map((item, index) => ({
          ...item,
          score: item.score + Math.max(0, scores[index] ?? 0) * 24
        })),
        ...matchedItems.slice(candidates.length)
      ].sort((a, b) => b.score - a.score)
    } catch {
      matchedItems = matchedItems.sort((a, b) => b.score - a.score)
    }
  }

  const fallbackItems =
    matchedItems.length > 0
      ? []
      : bases.flatMap((base) => {
          const chunks =
            base.chunks && base.chunks.length > 0
              ? base.chunks
              : buildKnowledgeChunks({
                  sourceFileIds: base.sourceFileIds,
                  files,
                  fallbackDescription: base.indexedContent || base.description
                })
          return chunks.slice(0, 1).map((chunk) => ({
            base,
            chunk,
            score: 0,
            graphEvidence: buildGraphEvidence({
              graph: base.graph,
              chunk,
              matchedNodeIds: new Set<string>(),
              relevantEdges: [],
              relevantFacts: [],
              fallback: true
            })
          }))
        })

  return [...matchedItems, ...fallbackItems]
    .slice(0, 4)
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
