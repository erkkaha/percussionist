// flow-introspection-tools.test.ts — verify inspect_task_flow MCP tool wiring.
//
// These tests read the tools.ts source file directly so we do not need to import
// the full module, which starts an HTTP server.

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = pathMod.dirname(fileURLToPath(import.meta.url));
const toolsSource = fs.readFileSync(pathMod.join(__dirname, '../tools.ts'), 'utf-8');

describe('inspect_task_flow tool wiring', () => {
  it('should register inspect_task_flow in TOOLS array', () => {
    expect(toolsSource).toContain("name: 'inspect_task_flow'");
  });

  it('should require project and task', () => {
    const toolStart = toolsSource.indexOf("name: 'inspect_task_flow'");
    expect(toolStart).toBeGreaterThan(-1);

    const blockStart = toolsSource.lastIndexOf('{', toolStart);
    let depth = 0;
    let blockEnd = -1;
    for (let i = blockStart; i < toolsSource.length; i++) {
      if (toolsSource[i] === '{') depth++;
      else if (toolsSource[i] === '}') {
        depth--;
        if (depth === 0) {
          blockEnd = i;
          break;
        }
      }
    }
    expect(blockEnd).toBeGreaterThan(toolStart);
    const block = toolsSource.slice(blockStart, blockEnd + 1);

    const requiredStart = block.indexOf('required:');
    expect(requiredStart).toBeGreaterThan(-1);
    let bracketDepth = 0;
    let reqOpen = -1;
    for (let i = requiredStart; i < block.length; i++) {
      if (block[i] === '[') {
        if (bracketDepth === 0) reqOpen = i;
        bracketDepth++;
      } else if (block[i] === ']') {
        bracketDepth--;
        if (bracketDepth === 0 && reqOpen >= 0) {
          const requiredArray = block.slice(reqOpen + 1, i);
          expect(requiredArray).toContain("'project'");
          expect(requiredArray).toContain("'task'");
          return;
        }
      }
    }
    throw new Error('Could not parse required array');
  });

  it('should accept optional namespace and verbose parameters', () => {
    expect(toolsSource).toContain('namespace');
    expect(toolsSource).toContain('verbose');
  });

  it('should have a callTool switch case for inspect_task_flow', () => {
    expect(toolsSource).toContain("case 'inspect_task_flow':");
  });

  it('should import inspectTaskFlow from flow-introspection module', () => {
    expect(toolsSource).toContain("from '../reconciler/flow-introspection.js'");
    expect(toolsSource).toContain('inspectTaskFlow');
  });
});
