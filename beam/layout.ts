import dagre from '@dagrejs/dagre';
import type { Breadboard, BreadboardWire, LayoutResult, LayoutNode, LayoutEdge, NodeType } from './types.ts';

const NODE_W = 340;
const NODE_H = 52;
const GAP_X = 20;
const GAP_Y = 14;
const FRAME_PAD_X = 30;
const FRAME_PAD_TOP = 50; // Room for frame label
const FRAME_PAD_BOTTOM = 30;
const GROUP_GAP = 28; // Gap between type groups (UI / Code / Store)
const MAX_COLS = 4; // Max nodes per row within a place

const TYPE_ORDER: NodeType[] = ['ui', 'code', 'store'];

interface PlaceLayout {
  placeId: string;
  label: string;
  width: number;
  height: number;
  children: { node: LayoutNode; localX: number; localY: number }[];
}

function layoutPlace(placeId: string, label: string, children: { id: string; type: NodeType; label: string }[]): PlaceLayout {
  // Group children by type
  const groups = new Map<NodeType, typeof children>();
  for (const child of children) {
    const list = groups.get(child.type) ?? [];
    list.push(child);
    groups.set(child.type, list);
  }

  const laid: PlaceLayout['children'] = [];
  let curY = FRAME_PAD_TOP;
  let maxRowWidth = 0;

  for (const type of TYPE_ORDER) {
    const group = groups.get(type);
    if (!group || group.length === 0) continue;

    // Arrange in rows of MAX_COLS
    for (let i = 0; i < group.length; i++) {
      const col = i % MAX_COLS;
      const row = Math.floor(i / MAX_COLS);
      const localX = FRAME_PAD_X + col * (NODE_W + GAP_X);
      const localY = curY + row * (NODE_H + GAP_Y);

      laid.push({
        node: {
          id: group[i].id,
          x: 0, y: 0, // Will be set after place positioning
          width: NODE_W,
          height: NODE_H,
          type: group[i].type,
          label: group[i].label,
          parentId: placeId,
        },
        localX,
        localY,
      });

      const rightEdge = localX + NODE_W;
      if (rightEdge > maxRowWidth) maxRowWidth = rightEdge;
    }

    const rowCount = Math.ceil(group.length / MAX_COLS);
    curY += rowCount * (NODE_H + GAP_Y) + GROUP_GAP;
  }

  // Minimum frame size so empty/small places are visible
  const minWidth = Math.max(label.length * 12 + FRAME_PAD_X * 2, 200);
  const width = Math.max(maxRowWidth + FRAME_PAD_X, minWidth);
  const height = Math.max(curY - GROUP_GAP + FRAME_PAD_BOTTOM, 80);

  return { placeId, label, width, height, children: laid };
}

export function computeLayout(breadboard: Breadboard): LayoutResult {
  const placeNodes = breadboard.nodes.filter(n => n.type === 'place');
  const childNodes = breadboard.nodes.filter(n => n.type !== 'place');

  // Group children by placeId
  const childrenByPlace = new Map<string, typeof childNodes>();
  const orphans: typeof childNodes = [];
  for (const node of childNodes) {
    if (node.placeId) {
      const list = childrenByPlace.get(node.placeId) ?? [];
      list.push(node);
      childrenByPlace.set(node.placeId, list);
    } else {
      orphans.push(node);
    }
  }

  // Layout each place internally
  const placeLayouts = new Map<string, PlaceLayout>();
  for (const place of placeNodes) {
    const children = childrenByPlace.get(place.id) ?? [];
    const pl = layoutPlace(place.id, place.label, children);
    placeLayouts.set(place.id, pl);
  }

  // Use dagre to position places relative to each other
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: 'TB',
    nodesep: 100,
    ranksep: 120,
    marginx: 40,
    marginy: 40,
  });
  g.setDefaultEdgeLabel(() => ({}));

  const placeIds = new Set(placeNodes.map(n => n.id));

  for (const place of placeNodes) {
    const pl = placeLayouts.get(place.id)!;
    g.setNode(place.id, { width: pl.width, height: pl.height });
  }

  // Add inter-place edges (deduplicated) to influence place ordering
  const interPlaceEdges = new Set<string>();
  for (const wire of breadboard.wires) {
    const fromPlace = breadboard.nodes.find(n => n.id === wire.from)?.placeId;
    const toPlace = breadboard.nodes.find(n => n.id === wire.to)?.placeId;
    if (fromPlace && toPlace && fromPlace !== toPlace && placeIds.has(fromPlace) && placeIds.has(toPlace)) {
      const key = `${fromPlace}->${toPlace}`;
      if (!interPlaceEdges.has(key)) {
        interPlaceEdges.add(key);
        g.setEdge(fromPlace, toPlace);
      }
    }
    // Also handle edges to places directly
    if (placeIds.has(wire.to) && fromPlace && fromPlace !== wire.to) {
      const key = `${fromPlace}->${wire.to}`;
      if (!interPlaceEdges.has(key)) {
        interPlaceEdges.add(key);
        g.setEdge(fromPlace, wire.to);
      }
    }
  }

  dagre.layout(g);

  // Collect all layout nodes
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];

  for (const place of placeNodes) {
    const dagreNode = g.node(place.id);
    const pl = placeLayouts.get(place.id)!;
    const placeX = dagreNode.x - dagreNode.width / 2;
    const placeY = dagreNode.y - dagreNode.height / 2;

    // Place frame
    nodes.push({
      id: place.id,
      x: placeX,
      y: placeY,
      width: pl.width,
      height: pl.height,
      type: 'place',
      label: place.label,
    });

    // Children positioned within frame
    for (const child of pl.children) {
      nodes.push({
        ...child.node,
        x: placeX + child.localX,
        y: placeY + child.localY,
      });
    }
  }

  // Edges (filter to valid node-to-node, skip place targets)
  const nodeIdSet = new Set(nodes.map(n => n.id));
  for (const wire of breadboard.wires) {
    if (nodeIdSet.has(wire.from) && nodeIdSet.has(wire.to) && !placeIds.has(wire.from) && !placeIds.has(wire.to)) {
      edges.push({ from: wire.from, to: wire.to, kind: wire.kind });
    }
  }

  return { nodes, edges };
}
