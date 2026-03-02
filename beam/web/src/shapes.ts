import { createShapeId, toRichText, type Editor } from 'tldraw';
import type { LayoutResult, LayoutNode } from '../../types';

const COLOR_MAP: Record<string, string> = {
  place: 'blue',
  ui: 'light-red',
  code: 'grey',
  store: 'violet',
};

const GEO_MAP: Record<string, string> = {
  ui: 'rectangle',
  code: 'rectangle',
  store: 'cloud',
};

export function renderBreadboard(editor: Editor, layout: LayoutResult) {
  const allShapes = editor.getCurrentPageShapes();
  if (allShapes.length > 0) {
    editor.deleteShapes(allShapes.map(s => s.id));
  }

  const nodeMap = new Map<string, LayoutNode>();
  for (const node of layout.nodes) {
    nodeMap.set(node.id, node);
  }

  const places = layout.nodes.filter(n => n.type === 'place');
  const children = layout.nodes.filter(n => n.type !== 'place');

  // Frames for places
  for (const place of places) {
    editor.createShape({
      id: createShapeId(place.id),
      type: 'frame',
      x: place.x,
      y: place.y,
      props: {
        w: place.width,
        h: place.height,
        name: `${place.id}: ${place.label}`,
        color: COLOR_MAP.place,
      },
    });
  }

  // Geo shapes — absolute coords, then reparent
  for (const node of children) {
    const shapeId = createShapeId(node.id);
    const color = COLOR_MAP[node.type] ?? 'black';
    const geo = GEO_MAP[node.type] ?? 'rectangle';

    editor.createShape({
      id: shapeId,
      type: 'geo',
      x: node.x,
      y: node.y,
      props: {
        geo,
        w: node.width,
        h: node.height,
        color,
        fill: 'semi',
        richText: toRichText(`${node.id}: ${node.label}`),
        size: 's',
        font: 'sans',
        verticalAlign: 'middle',
        align: 'middle',
      },
    });

    if (node.parentId) {
      editor.reparentShapes([shapeId], createShapeId(node.parentId));
    }
  }

  // Arrows — wires_out only, subtle
  for (const edge of layout.edges) {
    if (edge.kind === 'returns_to') continue;
    if (!nodeMap.has(edge.from) || !nodeMap.has(edge.to)) continue;

    const arrowId = createShapeId(`${edge.from}-${edge.to}`);

    editor.createShape({
      id: arrowId,
      type: 'arrow',
      x: 0,
      y: 0,
      opacity: 0.4,
      props: {
        dash: 'solid',
        color: 'light-blue',
        size: 's',
      },
    });

    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: createShapeId(edge.from),
      props: {
        terminal: 'start',
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isPrecise: false,
        isExact: false,
      },
    });

    editor.createBinding({
      type: 'arrow',
      fromId: arrowId,
      toId: createShapeId(edge.to),
      props: {
        terminal: 'end',
        normalizedAnchor: { x: 0.5, y: 0.5 },
        isPrecise: false,
        isExact: false,
      },
    });
  }

  editor.zoomToFit({ animation: { duration: 300 } });
}
