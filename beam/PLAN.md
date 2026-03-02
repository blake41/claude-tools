# Plan: Build `beam` — Breadboard-to-TLDraw CLI Tool

## Context

Ryan Singer's shaping methodology produces breadboard documents with structured affordance tables (Places, UI Affordances, Code Affordances, Data Stores, with Wires Out / Returns To columns). He built a private tool called `beam` that renders Mermaid diagrams from markdown to TLDraw, and described wanting to skip Mermaid entirely and render breadboards as native TLDraw shapes. That tool doesn't exist publicly. We're building it.

**Immediate use case:** Visualize the V4 breadboard at `~/Documents/Development/clay/slack-project-v4-prototype/plans/v4/breadboard.md`

## What we're building

A CLI tool: `beam <file.md>` that:
1. Parses breadboard affordance tables from markdown
2. Computes layout using dagre (compound graph with places as containers)
3. Renders as native TLDraw shapes (frames, colored rectangles, bound arrows)
4. Serves a local TLDraw canvas in the browser with hot-reload on file change

## Project structure

```
~/Documents/Development/tools/beam/
├── package.json              # Root: dagre dependency
├── beam                      # CLI entry (bash shim)
├── types.ts                  # Shared types (Breadboard, LayoutResult)
├── parser.ts                 # Parse markdown tables → Breadboard
├── layout.ts                 # Dagre compound layout → LayoutResult
├── server.ts                 # Bun HTTP + WebSocket + file watcher
├── web/                      # Vite + React + TLDraw app
│   ├── package.json          # react, react-dom, tldraw, vite
│   ├── vite.config.ts
│   ├── index.html
│   └── src/
│       ├── main.tsx          # React entry
│       ├── App.tsx           # TLDraw wrapper + WebSocket client
│       └── shapes.ts         # LayoutResult → TLDraw shapes + arrow bindings
```

Symlink: `~/.local/bin/beam → ~/Documents/Development/tools/beam/beam`

## Implementation steps

### 1. Scaffold project
- Create directory structure
- `package.json` (root): dagre dep
- `web/package.json`: react, react-dom, tldraw, vite, @vitejs/plugin-react
- `bun install` in both directories

### 2. `types.ts` — Shared types (~30 lines)
```typescript
BreadboardNode { id, type, label, placeId?, description? }
BreadboardWire { from, to, kind: 'wires_out' | 'returns_to' }
Breadboard { nodes, wires }
LayoutNode { id, x, y, width, height, type, label, parentId? }
LayoutEdge { from, to, kind }
LayoutResult { nodes, edges }
```

### 3. `parser.ts` — Markdown table parser (~150 lines)
- Split markdown by `##` headings
- Classify sections by keywords: "Places", "UI Affordances", "Code Affordances", "Data Stores"
- Parse each markdown table (detect `|` lines, split by `|`, trim)
- Extract wiring refs from "Wires Out" / "Returns To" columns via regex: `→\s*([A-Z]\d+[a-z_]*)`
- Map "Place" column values to place IDs
- Tolerant of column name variations

### 4. `layout.ts` — Dagre compound layout (~100 lines)
- Create dagre compound graph (`{ compound: true }`)
- Add place nodes as parents
- Add affordance/store nodes as children (set parent via `g.setParent`)
- Add edges for wires
- Run dagre layout (TB direction)
- Convert center-based coords to top-left
- Return LayoutResult

### 5. `web/src/shapes.ts` — TLDraw shape mapping (~200 lines)
- Color map: places=blue frames, UI=light-red, code=grey, stores=light-violet
- Create frames for places
- Create geo rectangles for affordances (with labels showing ID + name)
- Child shapes use parent-relative coordinates
- Create arrows with bindings (solid for wires_out, dashed for returns_to)
- `editor.zoomToFit()` after rendering

### 6. `web/src/App.tsx` + `main.tsx` (~80 lines)
- React app wrapping `<Tldraw onMount={...} />`
- WebSocket client connecting to server
- On message: call `renderBreadboard(editor, layout)`
- Status indicator in corner

### 7. `server.ts` — Bun server (~80 lines)
- Single port (5555)
- Parse markdown on startup
- Serve `web/dist/` as static files
- WebSocket on `/ws`: send layout on connect
- `fs.watch` on markdown file: re-parse, re-layout, push to all clients

### 8. `beam` CLI shim (~40 lines)
- Bash script
- Resolves file to absolute path
- Builds web if `web/dist/` doesn't exist
- Starts server, opens browser

### 9. Install and test
- `chmod +x beam`
- `ln -s ~/Documents/Development/tools/beam/beam ~/.local/bin/beam`
- `beam ~/Documents/Development/clay/slack-project-v4-prototype/plans/v4/breadboard.md`

## Verification

1. `beam plans/v4/breadboard.md` opens browser with TLDraw canvas
2. All 8 places render as blue frames
3. 33 UI affordances render as pink rectangles inside their parent frames
4. 37 code affordances render as grey rectangles
5. 6 data stores render as lavender rectangles
6. Arrows connect affordances (solid for Wires Out, dashed for Returns To)
7. Edit `breadboard.md` → canvas updates automatically
8. Pan, zoom, select, move shapes works (TLDraw native)

## Key dependencies
- `tldraw` v4.4.0 (latest stable, Apache 2.0)
- `dagre` v0.8.5 + `@dagrejs/graphlib` (MIT)
- `react` 19, `vite` 6, `@vitejs/plugin-react` 4
- Bun runtime (already installed)
