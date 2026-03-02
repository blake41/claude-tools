import type { Breadboard, BreadboardNode, BreadboardWire, NodeType, WireKind } from './types.ts';

interface TableRow {
  cells: string[];
  headers: string[];
}

function parseTable(lines: string[]): TableRow[] {
  const rows: TableRow[] = [];
  const tableLines = lines.filter(l => l.trim().startsWith('|'));
  if (tableLines.length < 2) return rows;

  const headers = tableLines[0]
    .split('|')
    .map(c => c.trim())
    .filter(Boolean);

  // Skip header + separator
  for (let i = 2; i < tableLines.length; i++) {
    const cells = tableLines[i]
      .split('|')
      .map(c => c.trim())
      .filter(Boolean);
    if (cells.length > 0) {
      rows.push({ cells, headers });
    }
  }
  return rows;
}

function classifySection(heading: string): NodeType | null {
  const h = heading.toLowerCase();
  if (h.includes('places') || h.includes('place')) return 'place';
  if (h.includes('ui affordance')) return 'ui';
  if (h.includes('code affordance')) return 'code';
  if (h.includes('data store')) return 'store';
  return null;
}

function colIndex(headers: string[], ...keywords: string[]): number {
  return headers.findIndex(h => {
    const hl = h.toLowerCase();
    return keywords.some(k => hl.includes(k));
  });
}

function extractRefs(text: string): string[] {
  const refs: string[] = [];
  // Match patterns like → N1, → P2.1, → S3, → N24_be
  const re = /→\s*([A-Z]\d+[a-z_.\d]*)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

function normalizeId(raw: string): string {
  // Strip bold markers and whitespace
  return raw.replace(/\*\*/g, '').trim();
}

function isGroupHeader(row: TableRow, idCol: number): boolean {
  // Group headers like "| **Blueprint Wizard** | | | ..." have bold text and empty ID-like columns
  const id = row.cells[idCol]?.replace(/\*\*/g, '').trim() ?? '';
  // If the ID cell doesn't match a node pattern (letter+digits), it's a group header
  return !/^[A-Z]\d/.test(id);
}

export function parseBreadboard(markdown: string): Breadboard {
  const nodes: BreadboardNode[] = [];
  const wires: BreadboardWire[] = [];
  const nodeIds = new Set<string>();

  // Split into sections by ## headings
  const sections: { heading: string; lines: string[] }[] = [];
  const lines = markdown.split('\n');
  let current: { heading: string; lines: string[] } | null = null;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { heading: headingMatch[1], lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  for (const section of sections) {
    const type = classifySection(section.heading);
    if (!type) continue;

    const rows = parseTable(section.lines);
    if (rows.length === 0) continue;

    const headers = rows[0].headers;

    if (type === 'place') {
      const idCol = colIndex(headers, '#');
      const nameCol = colIndex(headers, 'place');
      const descCol = colIndex(headers, 'description');

      for (const row of rows) {
        const id = normalizeId(row.cells[idCol] ?? '');
        const label = row.cells[nameCol]?.trim() ?? '';
        if (!id || !label || !id.match(/^P/)) continue;
        nodes.push({ id, type: 'place', label, description: row.cells[descCol]?.trim() });
        nodeIds.add(id);
      }
    } else if (type === 'ui' || type === 'code') {
      const idCol = colIndex(headers, '#');
      const placeCol = colIndex(headers, 'place');
      const affordCol = colIndex(headers, 'affordance');
      const wiresOutCol = colIndex(headers, 'wires out');
      const returnsToCol = colIndex(headers, 'returns to');

      for (const row of rows) {
        if (isGroupHeader(row, idCol)) continue;

        const id = normalizeId(row.cells[idCol] ?? '');
        if (!id || !/^[A-Z]\d/.test(id)) continue;

        const placeRaw = row.cells[placeCol]?.trim() ?? '';
        const label = row.cells[affordCol]?.trim() ?? id;

        nodes.push({
          id,
          type,
          label,
          placeId: placeRaw || undefined,
        });
        nodeIds.add(id);

        // Parse wires
        if (wiresOutCol >= 0) {
          const wiresOutText = row.cells[wiresOutCol] ?? '';
          for (const ref of extractRefs(wiresOutText)) {
            wires.push({ from: id, to: ref, kind: 'wires_out' });
          }
        }
        if (returnsToCol >= 0) {
          const returnsToText = row.cells[returnsToCol] ?? '';
          for (const ref of extractRefs(returnsToText)) {
            wires.push({ from: id, to: ref, kind: 'returns_to' });
          }
        }
      }
    } else if (type === 'store') {
      const idCol = colIndex(headers, '#');
      const placeCol = colIndex(headers, 'place');
      const storeCol = colIndex(headers, 'store');
      const descCol = colIndex(headers, 'description');

      for (const row of rows) {
        const id = normalizeId(row.cells[idCol] ?? '');
        if (!id || !/^S\d/.test(id)) continue;

        const placeRaw = row.cells[placeCol]?.trim() ?? '';
        const label = row.cells[storeCol]?.trim() ?? id;

        nodes.push({
          id,
          type: 'store',
          label,
          placeId: placeRaw || undefined,
          description: row.cells[descCol]?.trim(),
        });
        nodeIds.add(id);
      }
    }
  }

  // Filter wires to only reference existing nodes
  const validWires = wires.filter(w => nodeIds.has(w.from) && nodeIds.has(w.to));

  return { nodes, wires: validWires };
}
