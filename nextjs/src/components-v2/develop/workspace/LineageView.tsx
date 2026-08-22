'use client';

import React, { useState, useMemo, useCallback, useRef } from 'react';
import {
    Database,
    Table2,
    GitBranch,
    Layers,
    AlertCircle,
    Loader2,
    RefreshCw,
    ZoomIn,
    ZoomOut,
    Maximize2,
    Columns3,
    Search
} from 'lucide-react';

// Types
interface LineageNode {
    id: string;
    name: string;
    type: string;
    schema?: string;
    position?: 'upstream' | 'current' | 'downstream';
    columns?: string[];
}

interface LineageEdge {
    from: string;
    to: string;
    fromColumn?: string;
    toColumn?: string;
}

interface ColumnLineageEntry {
    column: string;
    table: string;
    expression?: string;
}

interface LineageViewProps {
    nodes: LineageNode[];
    edges: LineageEdge[];
    columnLineage?: Record<string, ColumnLineageEntry[]>;
    currentModel?: string;
    isLoading?: boolean;
    error?: string;
    onRefresh?: () => void;
}

// Constants
const NODE_WIDTH = 260;
const NODE_HEADER_HEIGHT = 44;
const NODE_GAP_X = 180;
const NODE_GAP_Y = 30;
const PADDING = 40;
type TraceMode = 'all' | 'backward' | 'forward';

// Get colors based on node type
const getNodeStyle = (type: string, isCurrent: boolean) => {
    if (isCurrent) {
        return { stroke: '#0891b2', fill: '#f8fdff', headerFill: '#dff5fa', accent: '#0e7490' };
    }
    switch (type) {
        case 'source': return { stroke: '#65a30d', fill: '#fbfef7', headerFill: '#edf7dc', accent: '#4d7c0f' };
        case 'seed': return { stroke: '#d97706', fill: '#fffdf7', headerFill: '#fdf1d5', accent: '#b45309' };
        case 'model': return { stroke: '#5b8def', fill: '#fbfcff', headerFill: '#e8effd', accent: '#3567c7' };
        default: return { stroke: '#94a3b8', fill: '#ffffff', headerFill: '#f1f5f9', accent: '#64748b' };
    }
};

// Main LineageView Component
export default function LineageView({
    nodes,
    edges,
    columnLineage,
    currentModel,
    isLoading,
    error,
    onRefresh
}: LineageViewProps) {
    const [traceMode, setTraceMode] = useState<TraceMode>('all');
    const [zoom, setZoom] = useState(1);
    const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
    const svgRef = useRef<SVGSVGElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const [showColumns, setShowColumns] = useState(true);
    const [columnFilter, setColumnFilter] = useState('');

    // Column-level lineage: which upstream column each output column came from.
    // /dbt/lineage already returns it; this panel is what makes it visible.
    const columnEntries = useMemo(
        () => Object.entries(columnLineage ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        [columnLineage]
    );

    const filteredColumnEntries = useMemo(() => {
        const needle = columnFilter.trim().toLowerCase();
        if (!needle) return columnEntries;
        return columnEntries.filter(([column, sources]) =>
            column.toLowerCase().includes(needle) ||
            sources.some(source =>
                source.column.toLowerCase().includes(needle) ||
                source.table.toLowerCase().includes(needle)
            )
        );
    }, [columnEntries, columnFilter]);

    const visibleNodes = useMemo(() => {
        if (traceMode === 'all') return nodes;
        return nodes.filter(node => node.position === 'current' || node.position === (traceMode === 'backward' ? 'upstream' : 'downstream'));
    }, [nodes, traceMode]);

    const visibleNodeIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes]);

    // Group nodes by position
    const nodeGroups = useMemo(() => {
        return {
            upstream: visibleNodes.filter(n => n.position === 'upstream'),
            current: visibleNodes.filter(n => n.position === 'current'),
            downstream: visibleNodes.filter(n => n.position === 'downstream')
        };
    }, [visibleNodes]);

    // Calculate node heights (considering expansion)
    const getNodeHeight = useCallback((_node: LineageNode) => {
        return NODE_HEADER_HEIGHT;
    }, []);

    // Calculate positions for all nodes
    const nodePositions = useMemo(() => {
        const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};

        const groups = [
            { nodes: nodeGroups.upstream, xBase: PADDING },
            { nodes: nodeGroups.current, xBase: PADDING + NODE_WIDTH + NODE_GAP_X },
            { nodes: nodeGroups.downstream, xBase: PADDING + (NODE_WIDTH + NODE_GAP_X) * 2 }
        ];

        groups.forEach(({ nodes: groupNodes, xBase }) => {
            let y = PADDING;
            groupNodes.forEach((node: LineageNode) => {
                const height = getNodeHeight(node);
                positions[node.id] = { x: xBase, y, width: NODE_WIDTH, height };
                y += height + NODE_GAP_Y;
            });
        });

        return positions;
    }, [nodeGroups, getNodeHeight]);

    // Auto-generate edges between upstream->current and current->downstream
    const computedEdges = useMemo(() => {
        // If edges provided, use them
        if (edges && edges.length > 0) {
            return edges.filter(edge => visibleNodeIds.has(edge.from) && visibleNodeIds.has(edge.to));
        }

        // Otherwise, generate edges from node positions
        const generatedEdges: LineageEdge[] = [];
        const currentNodes = nodeGroups.current;

        // Connect upstream to current
        nodeGroups.upstream.forEach((upNode: LineageNode) => {
            currentNodes.forEach((curNode: LineageNode) => {
                generatedEdges.push({ from: upNode.id, to: curNode.id });
            });
        });

        // Connect current to downstream
        currentNodes.forEach((curNode: LineageNode) => {
            nodeGroups.downstream.forEach((downNode: LineageNode) => {
                generatedEdges.push({ from: curNode.id, to: downNode.id });
            });
        });

        return generatedEdges;
    }, [edges, nodeGroups, visibleNodeIds]);

    // Calculate SVG dimensions
    const svgSize = useMemo(() => {
        let maxX = 0, maxY = 0;
        const positions = Object.values(nodePositions) as { x: number; y: number; width: number; height: number }[];
        positions.forEach(pos => {
            maxX = Math.max(maxX, pos.x + pos.width);
            maxY = Math.max(maxY, pos.y + pos.height);
        });
        return {
            width: maxX + PADDING * 2,
            height: Math.max(maxY + PADDING * 2, 300)
        };
    }, [nodePositions]);

    const handleZoomIn = () => setZoom((z: number) => Math.min(z + 0.2, 2.5));
    const handleZoomOut = () => setZoom((z: number) => Math.max(z - 0.2, 0.3));
    const handleFitView = () => {
        setZoom(1);
        setPanOffset({ x: 0, y: 0 });
    };

    // Pan handlers
    const handleMouseDown = (e: React.MouseEvent) => {
        if (e.button === 0) {
            setIsDragging(true);
            setDragStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
        }
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (isDragging) {
            setPanOffset({
                x: e.clientX - dragStart.x,
                y: e.clientY - dragStart.y
            });
        }
    };

    const handleMouseUp = () => setIsDragging(false);

    // Draw bezier edge between two nodes
    const renderEdge = (edge: LineageEdge, index: number) => {
        const fromPos = nodePositions[edge.from];
        const toPos = nodePositions[edge.to];
        if (!fromPos || !toPos) return null;

        const startX = fromPos.x + fromPos.width;
        const startY = fromPos.y + NODE_HEADER_HEIGHT / 2;
        const endX = toPos.x;
        const endY = toPos.y + NODE_HEADER_HEIGHT / 2;

        const midX = (startX + endX) / 2;

        return (
            <g key={`edge-${index}`}>
                <path
                    d={`M ${startX} ${startY} C ${midX} ${startY}, ${midX} ${endY}, ${endX} ${endY}`}
                    fill="none"
                    stroke="#4b5563"
                    strokeWidth={2}
                    markerEnd="url(#arrowhead)"
                />
                {/* Connection dots */}
                <circle cx={startX} cy={startY} r={5} fill="#4b5563" />
                <circle cx={endX} cy={endY} r={5} fill="#4b5563" />
            </g>
        );
    };

    // Render a table node
    const renderNode = (node: LineageNode) => {
        const pos = nodePositions[node.id];
        if (!pos) return null;

        const isCurrent = node.position === 'current';
        const style = getNodeStyle(node.type, isCurrent);
        const hasColumns = node.columns && node.columns.length > 0;

        return (
            <g key={node.id} transform={`translate(${pos.x}, ${pos.y})`}>
                {/* Node background */}
                <rect
                    x={0}
                    y={0}
                    width={pos.width}
                    height={pos.height}
                    rx={8}
                    fill={style.fill}
                    stroke={style.stroke}
                    strokeWidth={2}
                />

                {/* Header */}
                <rect
                    x={0}
                    y={0}
                    width={pos.width}
                    height={NODE_HEADER_HEIGHT}
                    rx={8}
                    fill={style.headerFill}
                />

                {/* Type icon */}
                <foreignObject x={16} y={12} width={20} height={20}>
                    <div className="flex items-center justify-center" style={{ color: style.stroke }}>
                        {node.type === 'source' ? <Database className="w-4 h-4" /> :
                            node.type === 'seed' ? <Table2 className="w-4 h-4" /> :
                                <Layers className="w-4 h-4" />}
                    </div>
                </foreignObject>

                {/* Node name */}
                <text
                    x={54}
                    y={28}
                    fill="#334155"
                    fontSize={13}
                    fontWeight={600}
                >
                    {node.name.length > 22 ? node.name.slice(0, 22) + '...' : node.name}
                </text>

                {/* Column count badge */}
                {hasColumns && (
                    <g>
                        <rect
                            x={pos.width - 45}
                            y={12}
                            width={35}
                            height={20}
                            rx={10}
                            fill="rgba(255,255,255,0.7)"
                        />
                        <text
                            x={pos.width - 28}
                            y={26}
                            fill={style.accent}
                            fontSize={11}
                            textAnchor="middle"
                        >
                            {node.columns?.length}
                        </text>
                    </g>
                )}

                {/* Connection point - right side of header */}
                <circle
                    cx={pos.width}
                    cy={NODE_HEADER_HEIGHT / 2}
                    r={6}
                    fill="#ffffff"
                    stroke={style.stroke}
                    strokeWidth={2}
                />

                {/* Connection point - left side of header */}
                <circle
                    cx={0}
                    cy={NODE_HEADER_HEIGHT / 2}
                    r={6}
                    fill="#ffffff"
                    stroke={style.stroke}
                    strokeWidth={2}
                />

            </g>
        );
    };

    // Loading state
    if (isLoading) {
        return (
            <div className="h-full flex items-center justify-center bg-white">
                <div className="text-center">
                    <Loader2 className="w-8 h-8 animate-spin text-[#0078D4] mx-auto mb-3" />
                    <p className="text-sm text-[#616161]">Loading lineage...</p>
                </div>
            </div>
        );
    }

    // Error state
    if (error) {
        return (
            <div className="h-full flex items-center justify-center bg-white">
                <div className="text-center">
                    <AlertCircle className="w-8 h-8 text-[#D32F2F] mx-auto mb-3" />
                    <p className="text-sm text-[#D32F2F]">{error}</p>
                    {onRefresh && (
                        <button onClick={onRefresh} className="mt-3 px-3 py-1 text-xs bg-[#F3F2F1] hover:bg-[#E6E6E6] rounded text-[#242424] border border-[#E6E6E6]">
                            Retry
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // Empty state
    if (nodes.length === 0) {
        return (
            <div className="h-full flex items-center justify-center bg-white">
                <div className="text-center">
                    <GitBranch className="w-10 h-10 text-[#A0A0A0] mx-auto mb-3" />
                    <p className="text-sm text-[#616161]">No lineage data</p>
                    <p className="text-xs text-[#A0A0A0] mt-1">Run dbt compile or dbt run first</p>
                    {onRefresh && (
                        <button onClick={onRefresh} className="mt-4 px-4 py-1.5 text-xs bg-[#0078D4] hover:bg-[#106EBE] rounded text-white">
                            Load Lineage
                        </button>
                    )}
                </div>
            </div>
        );
    }

    // Calculate viewBox based on zoom and pan
    const viewBoxWidth = svgSize.width / zoom;
    const viewBoxHeight = svgSize.height / zoom;
    const viewBoxX = -panOffset.x / zoom;
    const viewBoxY = -panOffset.y / zoom;

    return (
        <div className="h-full flex flex-col bg-white" ref={containerRef}>
            {/* Toolbar */}
            <div className="flex items-center justify-between px-3 py-2 border-b border-[#E6E6E6] bg-[#FAF9F8]">
                <div className="flex items-center gap-2">
                    <GitBranch className="w-4 h-4 text-[#0078D4]" />
                    <span className="text-sm text-[#242424]">Data Lineage</span>
                    {currentModel && (
                        <span className="text-xs px-2 py-0.5 bg-[#0078D4]/10 text-[#0078D4] rounded">
                            {currentModel}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-1">
                    {columnEntries.length > 0 && (
                        <button
                            onClick={() => setShowColumns(open => !open)}
                            className={`flex items-center gap-1 px-2 py-1 mr-1 text-xs rounded ${showColumns ? 'bg-[#0078D4] text-white' : 'text-[#616161] hover:bg-[#E6E6E6]'}`}
                            title="Show which upstream column each output column comes from"
                        >
                            <Columns3 className="w-3.5 h-3.5" />
                            Columns ({columnEntries.length})
                        </button>
                    )}
                    {(['all', 'backward', 'forward'] as TraceMode[]).map(mode => (
                        <button
                            key={mode}
                            onClick={() => setTraceMode(mode)}
                            className={`px-2 py-1 text-xs rounded ${traceMode === mode ? 'bg-[#0078D4] text-white' : 'text-[#616161] hover:bg-[#E6E6E6]'}`}
                            title={mode === 'backward' ? 'Trace upstream dependencies' : mode === 'forward' ? 'Trace downstream dependents' : 'Show full lineage'}
                        >
                            {mode === 'all' ? 'All' : mode === 'backward' ? 'Backward' : 'Forward'}
                        </button>
                    ))}
                    <button onClick={handleZoomOut} className="p-1.5 hover:bg-[#E6E6E6] rounded text-[#616161] hover:text-[#242424]" title="Zoom Out">
                        <ZoomOut className="w-4 h-4" />
                    </button>
                    <span className="text-xs text-[#616161] w-10 text-center">{Math.round(zoom * 100)}%</span>
                    <button onClick={handleZoomIn} className="p-1.5 hover:bg-[#E6E6E6] rounded text-[#616161] hover:text-[#242424]" title="Zoom In">
                        <ZoomIn className="w-4 h-4" />
                    </button>
                    <button onClick={handleFitView} className="p-1.5 hover:bg-[#E6E6E6] rounded text-[#616161] hover:text-[#242424]" title="Reset View">
                        <Maximize2 className="w-4 h-4" />
                    </button>
                    {onRefresh && (
                        <button onClick={onRefresh} className="p-1.5 hover:bg-[#E6E6E6] rounded text-[#616161] hover:text-[#242424] ml-2" title="Refresh">
                            <RefreshCw className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </div>

            {/* Canvas + column lineage panel */}
            <div className="flex-1 flex min-h-0">
            <div
                className="flex-1 overflow-hidden bg-[#FAF9F8]"
                style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
            >
                <svg
                    ref={svgRef}
                    width="100%"
                    height="100%"
                    viewBox={`${viewBoxX} ${viewBoxY} ${viewBoxWidth} ${viewBoxHeight}`}
                    preserveAspectRatio="xMidYMid meet"
                >
                    {/* Definitions */}
                    <defs>
                        <marker
                            id="arrowhead"
                            markerWidth="10"
                            markerHeight="7"
                            refX="9"
                            refY="3.5"
                            orient="auto"
                        >
                            <polygon points="0 0, 10 3.5, 0 7" fill="#4b5563" />
                        </marker>
                        <marker
                            id="arrowhead-cyan"
                            markerWidth="10"
                            markerHeight="7"
                            refX="9"
                            refY="3.5"
                            orient="auto"
                        >
                            <polygon points="0 0, 10 3.5, 0 7" fill="#06b6d4" />
                        </marker>
                    </defs>

                    {/* Background grid pattern */}
                    <defs>
                        <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
                            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="rgba(0,0,0,0.05)" strokeWidth="1" />
                        </pattern>
                    </defs>
                    <rect x={viewBoxX} y={viewBoxY} width={viewBoxWidth} height={viewBoxHeight} fill="url(#grid)" />

                    {/* Edges (table level) */}
                    <g className="edges">
                        {computedEdges.map((edge: LineageEdge, idx: number) => renderEdge(edge, idx))}
                    </g>

                    {/* Nodes */}
                    <g className="nodes">
                        {visibleNodes.map(node => renderNode(node))}
                    </g>
                </svg>
            </div>

            {showColumns && columnEntries.length > 0 && (
                <aside className="w-72 shrink-0 overflow-auto border-l border-[#E6E6E6] bg-white">
                    <div className="sticky top-0 border-b border-[#E6E6E6] bg-white px-3 py-2">
                        <p className="text-xs font-medium text-[#242424]">Column lineage</p>
                        <div className="relative mt-1.5">
                            <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-[#A0A0A0]" />
                            <input
                                value={columnFilter}
                                onChange={event => setColumnFilter(event.target.value)}
                                placeholder="Filter columns"
                                className="h-7 w-full rounded border border-[#E6E6E6] pl-7 pr-2 text-xs focus:border-[#0078D4] focus:outline-none"
                            />
                        </div>
                    </div>
                    {filteredColumnEntries.length === 0 ? (
                        <p className="px-3 py-2 text-xs text-[#616161]">No column matches.</p>
                    ) : (
                        <ul className="divide-y divide-[#F3F2F1]">
                            {filteredColumnEntries.map(([column, sources]) => (
                                <li key={column} className="px-3 py-2">
                                    <p className="font-mono text-xs text-[#242424]">{column}</p>
                                    {sources.length === 0 ? (
                                        <p className="mt-0.5 text-[11px] text-[#A0A0A0]">
                                            no upstream column resolved
                                        </p>
                                    ) : (
                                        <ul className="mt-1 space-y-1">
                                            {sources.map((source, index) => (
                                                <li key={`${source.table}.${source.column}.${index}`}>
                                                    <p className="font-mono text-[11px] text-[#616161]">
                                                        ← {source.table}.{source.column}
                                                    </p>
                                                    {source.expression && (
                                                        <p
                                                            className="truncate font-mono text-[11px] text-[#A0A0A0]"
                                                            title={source.expression}
                                                        >
                                                            {source.expression}
                                                        </p>
                                                    )}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </li>
                            ))}
                        </ul>
                    )}
                </aside>
            )}
            </div>

            {/* Legend */}
            <div className="flex items-center justify-between px-3 py-2 border-t border-[#E6E6E6] bg-[#FAF9F8] text-xs">
                <div className="flex items-center gap-4 text-[#616161]">
                    <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded border-2 border-lime-600 bg-lime-50" />
                        Source
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded border-2 border-amber-600 bg-amber-50" />
                        Seed
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded border-2 border-blue-400 bg-blue-50" />
                        Model
                    </div>
                    <div className="flex items-center gap-1.5">
                        <div className="w-3 h-3 rounded border-2 border-cyan-600 bg-cyan-50" />
                        Current
                    </div>
                </div>
                <span className="text-[#64748b]">
                    {columnEntries.length > 0
                        ? 'Graph is table level; the Columns panel resolves each output column to its upstream column'
                        : 'Table level only · use Backward/Forward to trace related models and sources'}
                </span>
            </div>
        </div>
    );
}
