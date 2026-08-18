/**
 * Prepares the MCP stdio bridge bundle for packaged builds (v0.9.7).
 *
 * The bridge runs under the AI host's own Node (Claude Desktop etc.), not
 * Electron, so it must not depend on ESM-only SDK resolution or NODE_PATH.
 * esbuild bundles the bridge + @modelcontextprotocol/sdk + zod + deps into a
 * single self-contained CJS file at resources/mcp/mcp-stdio-bridge.cjs,
 * which electron-builder ships via extraResources ("resources/mcp" -> "mcp").
 *
 * Run after `vite build`, before `electron-builder`.
 */
const fs = require('node:fs');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const entry = path.join(projectRoot, 'scripts', 'mcp-stdio-bridge.mjs');
const outDir = path.join(projectRoot, 'resources', 'mcp');
const outFile = path.join(outDir, 'mcp-stdio-bridge.cjs');

function main() {
  if (!fs.existsSync(entry)) {
    console.warn('[prepare-mcp-bundle] scripts/mcp-stdio-bridge.mjs not found. Skipping.');
    return;
  }
  let esbuild;
  try {
    // Use the supported JS API so esbuild resolves its platform-specific
    // native package correctly on both Windows and Apple Silicon macOS.
    esbuild = require('esbuild');
  } catch {
    console.warn('[prepare-mcp-bundle] esbuild not installed; run npm install first. Skipping.');
    return;
  }

  fs.mkdirSync(outDir, { recursive: true });
  esbuild.buildSync({
    entryPoints: [entry],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    minify: true,
    legalComments: 'none',
    outfile: outFile,
  });
  const built = fs.readFileSync(outFile, 'utf8');
  if (!built.startsWith('#!')) {
    fs.writeFileSync(outFile, '#!/usr/bin/env node\n' + built, 'utf8');
  }
  console.log(`[prepare-mcp-bundle] bundled MCP stdio bridge → ${path.relative(projectRoot, outFile)}`);
}

main();
