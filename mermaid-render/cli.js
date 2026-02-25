#!/usr/bin/env node
import { renderMermaidAscii, renderMermaid, THEMES } from 'beautiful-mermaid';
import { readFileSync, writeFileSync } from 'fs';

const args = process.argv.slice(2);
const flags = {
  help: args.includes('--help') || args.includes('-h'),
  svg: args.includes('--svg'),
  output: null,
  theme: 'tokyo-night',
  ascii: args.includes('--ascii'),
};

// Parse --output/-o flag
const outputIdx = args.findIndex(a => a === '--output' || a === '-o');
if (outputIdx !== -1 && args[outputIdx + 1]) {
  flags.output = args[outputIdx + 1];
}

// Parse --theme flag
const themeIdx = args.findIndex(a => a === '--theme' || a === '-t');
if (themeIdx !== -1 && args[themeIdx + 1]) {
  flags.theme = args[themeIdx + 1];
}

if (flags.help) {
  console.log(`
mermaid-render - Render Mermaid diagrams beautifully

USAGE:
  mermaid-render [OPTIONS] [FILE]
  echo 'graph TD; A-->B' | mermaid-render

OPTIONS:
  -h, --help          Show this help
  --svg               Output SVG instead of ASCII
  --ascii             Use ASCII only (default: Unicode box-drawing)
  -o, --output FILE   Write output to file
  -t, --theme NAME    Theme name for SVG (default: tokyo-night)
  --list-themes       List available themes

EXAMPLES:
  # Render from stdin
  echo 'graph TD; A-->B; B-->C' | mermaid-render

  # Render from file
  mermaid-render diagram.mmd

  # Save SVG to file
  mermaid-render --svg -o diagram.svg diagram.mmd

SUPPORTED DIAGRAMS:
  - Flowcharts (graph TD/LR/BT/RL)
  - Sequence diagrams
  - State diagrams
  - Class diagrams
  - ER diagrams
`);
  process.exit(0);
}

if (args.includes('--list-themes')) {
  console.log('Available themes:');
  Object.keys(THEMES).forEach(t => console.log(`  - ${t}`));
  process.exit(0);
}

// Read input
let input = '';
const fileArg = args.find(a => !a.startsWith('-') && a !== flags.output && a !== flags.theme);

if (fileArg) {
  try {
    input = readFileSync(fileArg, 'utf-8');
  } catch (e) {
    console.error(`Error reading file: ${fileArg}`);
    process.exit(1);
  }
} else if (!process.stdin.isTTY) {
  // Read from stdin
  input = readFileSync(0, 'utf-8');
} else {
  console.error('No input provided. Use --help for usage.');
  process.exit(1);
}

input = input.trim();
if (!input) {
  console.error('Empty input');
  process.exit(1);
}

// Render
async function main() {
  try {
    let output;

    if (flags.svg) {
      const theme = THEMES[flags.theme] || THEMES['tokyo-night'] || {};
      output = await renderMermaid(input, theme);
    } else {
      output = renderMermaidAscii(input, { useAscii: flags.ascii });
    }

    if (flags.output) {
      writeFileSync(flags.output, output);
      console.log(`Written to ${flags.output}`);
    } else {
      console.log(output);
    }
  } catch (e) {
    console.error(`Render error: ${e.message}`);
    process.exit(1);
  }
}

main();
