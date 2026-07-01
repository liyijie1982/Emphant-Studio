import { SearchOutlined } from '@ant-design/icons'
import { Button, Empty, Input, Select, Switch, Tag, Typography } from 'antd'
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape'
import fcose from 'cytoscape-fcose'
import Graph from 'graphology'
import louvain from 'graphology-communities-louvain'
import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  KnowledgeGraph,
  KnowledgeGraphEdge,
  KnowledgeGraphFact,
  KnowledgeGraphNode
} from '@emphant/shared/types'

cytoscape.use(fcose)

const COMMUNITY_COLORS = [
  '#69d2e7',
  '#f38630',
  '#a7dbd8',
  '#e0e4cc',
  '#fa6900',
  '#b388ff',
  '#6ee7b7',
  '#ff8fab',
  '#facc15',
  '#93c5fd',
  '#c084fc',
  '#fb7185'
]

type SelectedGraphItem =
  | { type: 'node'; item: KnowledgeGraphNode }
  | { type: 'edge'; item: KnowledgeGraphEdge }
  | { type: 'fact'; item: KnowledgeGraphFact }

const buildCommunities = (graph: KnowledgeGraph) => {
  const network = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false })
  for (const node of graph.nodes) {
    network.mergeNode(node.id)
  }
  for (const edge of graph.edges) {
    if (edge.sourceNodeId !== edge.targetNodeId) {
      network.mergeEdge(edge.sourceNodeId, edge.targetNodeId, {
        weight: Math.max(edge.confidence || 0.3, 0.1)
      })
    }
  }
  if (network.order === 0) return {}
  return louvain(network, { getEdgeWeight: 'weight' }) as Record<string, number>
}

const graphElements = ({
  graph,
  communities,
  enabledTypes,
  showCommunities
}: {
  graph: KnowledgeGraph
  communities: Record<string, number>
  enabledTypes: Set<string>
  showCommunities: boolean
}) => {
  const visibleNodeIds = new Set(
    graph.nodes.filter((node) => enabledTypes.has(node.type)).map((node) => node.id)
  )
  const elements: ElementDefinition[] = graph.nodes
    .filter((node) => visibleNodeIds.has(node.id))
    .map((node) => {
      const communityId = communities[node.id] ?? 0
      return {
        data: {
          id: node.id,
          label: node.name,
          type: node.type,
          description: node.description ?? '',
          communityId,
          color: showCommunities
            ? COMMUNITY_COLORS[Math.abs(communityId) % COMMUNITY_COLORS.length]
            : '#69d2e7'
        },
        classes: 'kg-node'
      }
    })

  elements.push(
    ...graph.edges
      .filter(
        (edge) => visibleNodeIds.has(edge.sourceNodeId) && visibleNodeIds.has(edge.targetNodeId)
      )
      .map((edge) => ({
        data: {
          id: edge.id,
          source: edge.sourceNodeId,
          target: edge.targetNodeId,
          label: edge.relation,
          confidence: edge.confidence,
          description: edge.description ?? ''
        },
        classes: 'kg-edge'
      }))
  )

  return elements
}

const layoutConfig = (name: 'fcose' | 'circle' | 'concentric') => {
  if (name === 'fcose') {
    return {
      name: 'fcose',
      animate: true,
      animationDuration: 700,
      fit: true,
      padding: 36,
      quality: 'default',
      randomize: true,
      nodeRepulsion: 7200,
      idealEdgeLength: 128,
      edgeElasticity: 0.35,
      gravity: 0.32,
      numIter: 1800
    }
  }
  return {
    name,
    animate: true,
    animationDuration: 520,
    fit: true,
    padding: 42
  }
}

export const KnowledgeGraphVisual = ({ graph }: { graph: KnowledgeGraph }) => {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const cyRef = useRef<Core | null>(null)
  const [query, setQuery] = useState('')
  const [layoutName, setLayoutName] = useState<'fcose' | 'circle' | 'concentric'>('fcose')
  const [showCommunities, setShowCommunities] = useState(true)
  const [enabledTypes, setEnabledTypes] = useState<string[]>([])
  const [selectedItem, setSelectedItem] = useState<SelectedGraphItem | null>(null)

  const nodeName = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node.name])),
    [graph.nodes]
  )
  const nodeTypes = useMemo(
    () => [...new Set(graph.nodes.map((node) => node.type))].sort(),
    [graph.nodes]
  )
  const communities = useMemo(() => buildCommunities(graph), [graph])
  const typeSet = useMemo(
    () => new Set(enabledTypes.length ? enabledTypes : nodeTypes),
    [enabledTypes, nodeTypes]
  )
  const elements = useMemo(
    () =>
      graphElements({
        graph,
        communities,
        enabledTypes: typeSet,
        showCommunities
      }),
    [communities, graph, showCommunities, typeSet]
  )

  useEffect(() => {
    if (enabledTypes.length === 0 && nodeTypes.length > 0) {
      setEnabledTypes(nodeTypes)
    }
  }, [enabledTypes.length, nodeTypes])

  useEffect(() => {
    if (!containerRef.current) return
    const cy = cytoscape({
      container: containerRef.current,
      elements,
      minZoom: 0.18,
      maxZoom: 2.6,
      wheelSensitivity: 0.22,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': 'data(color)',
            color: '#eef5ff',
            width: 42,
            height: 42,
            'border-width': 2,
            'border-color': 'rgba(255,255,255,0.42)',
            'font-size': 11,
            'font-weight': 700,
            'text-outline-width': 3,
            'text-outline-color': '#101827',
            'text-valign': 'bottom',
            'text-margin-y': 8,
            'overlay-padding': 8
          }
        },
        {
          selector: 'edge',
          style: {
            label: 'data(label)',
            width: '1.5px',
            'curve-style': 'bezier',
            'line-color': 'rgba(148, 163, 184, 0.54)',
            'target-arrow-color': 'rgba(148, 163, 184, 0.72)',
            'target-arrow-shape': 'triangle',
            'font-size': 9,
            color: '#b8c3d6',
            'text-background-color': '#111827',
            'text-background-opacity': 0.74,
            'text-background-padding': '3px',
            'text-rotation': 'autorotate'
          }
        },
        {
          selector: '.is-dimmed',
          style: {
            opacity: 0.12
          }
        },
        {
          selector: '.is-highlighted',
          style: {
            opacity: 1,
            'border-width': '4px',
            'border-color': '#ffffff',
            'line-color': '#7dd3fc',
            'target-arrow-color': '#7dd3fc',
            'z-index': 20
          }
        },
        {
          selector: '.is-search-hit',
          style: {
            'border-width': '5px',
            'border-color': '#fde68a'
          }
        }
      ],
      layout: layoutConfig(layoutName)
    })
    cyRef.current = cy

    cy.on('tap', 'node', (event) => {
      const node = graph.nodes.find((item) => item.id === event.target.id())
      if (!node) return
      setSelectedItem({ type: 'node', item: node })
      const neighborhood = event.target.closedNeighborhood()
      cy.elements().addClass('is-dimmed')
      neighborhood.removeClass('is-dimmed').addClass('is-highlighted')
    })

    cy.on('tap', 'edge', (event) => {
      const edge = graph.edges.find((item) => item.id === event.target.id())
      if (!edge) return
      setSelectedItem({ type: 'edge', item: edge })
      cy.elements().addClass('is-dimmed')
      event.target
        .connectedNodes()
        .union(event.target)
        .removeClass('is-dimmed')
        .addClass('is-highlighted')
    })

    cy.on('tap', (event) => {
      if (event.target !== cy) return
      setSelectedItem(null)
      cy.elements().removeClass('is-dimmed is-highlighted is-search-hit')
    })

    return () => {
      cy.destroy()
      cyRef.current = null
    }
  }, [elements, graph.edges, graph.nodes, layoutName])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    cy.elements().removeClass('is-search-hit')
    const trimmed = query.trim().toLowerCase()
    if (!trimmed) return
    const hits = cy.nodes().filter((node) => {
      const label = String(node.data('label') ?? '').toLowerCase()
      const type = String(node.data('type') ?? '').toLowerCase()
      return label.includes(trimmed) || type.includes(trimmed)
    })
    hits.addClass('is-search-hit')
    if (hits.length > 0) {
      cy.animate({
        fit: { eles: hits.closedNeighborhood(), padding: 80 },
        duration: 420
      })
    }
  }, [query])

  const runLayout = () => {
    const cy = cyRef.current
    if (!cy) return
    cy.layout(layoutConfig(layoutName)).run()
  }

  if (graph.nodes.length === 0) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无实体可绘制" />
  }

  return (
    <div className="knowledge-graph-visual">
      <div className="knowledge-graph-toolbar">
        <Input
          allowClear
          value={query}
          prefix={<SearchOutlined />}
          placeholder="搜索实体或类型"
          onChange={(event) => setQuery(event.target.value)}
        />
        <Select
          value={layoutName}
          options={[
            { value: 'fcose', label: '力导向' },
            { value: 'concentric', label: '同心层级' },
            { value: 'circle', label: '环形' }
          ]}
          onChange={setLayoutName}
        />
        <Select
          mode="multiple"
          maxTagCount="responsive"
          value={enabledTypes}
          options={nodeTypes.map((type) => ({ value: type, label: type }))}
          placeholder="实体类型"
          onChange={setEnabledTypes}
        />
        <span className="knowledge-graph-switch">
          <Switch checked={showCommunities} onChange={setShowCommunities} />
          <small>社区聚类</small>
        </span>
        <Button onClick={runLayout}>重新布局</Button>
      </div>

      <div className="knowledge-graph-stage">
        <div ref={containerRef} className="knowledge-graph-canvas" />
        <aside className="knowledge-graph-detail">
          {selectedItem ? (
            <>
              {selectedItem.type === 'node' && (
                <>
                  <Typography.Title level={5}>{selectedItem.item.name}</Typography.Title>
                  <Tag>{selectedItem.item.type}</Tag>
                  {selectedItem.item.description && <p>{selectedItem.item.description}</p>}
                  {selectedItem.item.aliases.length > 0 && (
                    <small>别名：{selectedItem.item.aliases.join('、')}</small>
                  )}
                  <small>
                    社区：{communities[selectedItem.item.id] ?? 0} · 来源：
                    {selectedItem.item.sourceFileIds.length} 个资产
                  </small>
                </>
              )}
              {selectedItem.type === 'edge' && (
                <>
                  <Typography.Title level={5}>{selectedItem.item.relation}</Typography.Title>
                  <p>
                    {nodeName.get(selectedItem.item.sourceNodeId) ?? '未知实体'} →{' '}
                    {nodeName.get(selectedItem.item.targetNodeId) ?? '未知实体'}
                  </p>
                  {selectedItem.item.description && <p>{selectedItem.item.description}</p>}
                  <small>置信度：{Math.round(selectedItem.item.confidence * 100)}%</small>
                </>
              )}
              {selectedItem.type === 'fact' && (
                <>
                  <Typography.Title level={5}>{selectedItem.item.predicate}</Typography.Title>
                  <p>{selectedItem.item.value}</p>
                  <small>置信度：{Math.round(selectedItem.item.confidence * 100)}%</small>
                </>
              )}
            </>
          ) : (
            <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="点击节点或关系查看详情" />
          )}
        </aside>
      </div>
    </div>
  )
}
