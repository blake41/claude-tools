export type NodeType = 'place' | 'ui' | 'code' | 'store';

export interface BreadboardNode {
  id: string;
  type: NodeType;
  label: string;
  placeId?: string;
  description?: string;
}

export type WireKind = 'wires_out' | 'returns_to';

export interface BreadboardWire {
  from: string;
  to: string;
  kind: WireKind;
}

export interface Breadboard {
  nodes: BreadboardNode[];
  wires: BreadboardWire[];
}

export interface LayoutNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: NodeType;
  label: string;
  parentId?: string;
}

export interface LayoutEdge {
  from: string;
  to: string;
  kind: WireKind;
}

export interface LayoutResult {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
}
