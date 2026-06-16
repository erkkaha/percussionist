// findings-tools.test.ts — schema verification for list_findings, update_finding,
// create_task_from_finding MCP tools.
//
// Follows the source-string-parsing pattern from approve-tool.test.ts.

import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import pathMod from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = pathMod.dirname(fileURLToPath(import.meta.url));
const toolsSource = fs.readFileSync(pathMod.join(__dirname, '../tools.ts'), 'utf-8');

function extractToolBlock(name: string): string | null {
  const nameIdx = toolsSource.indexOf(`name: '${name}'`);
  if (nameIdx < 0) return null;

  let openBrace = -1;
  for (let i = nameIdx - 1; i >= Math.max(0, nameIdx - 200); i--) {
    if (toolsSource[i] === '{') {
      openBrace = i;
      break;
    }
  }
  if (openBrace < 0) return null;

  let depth = 0;
  for (let i = openBrace; i < toolsSource.length; i++) {
    if (toolsSource[i] === '{') depth++;
    else if (toolsSource[i] === '}') {
      depth--;
      if (depth === 0) return toolsSource.slice(openBrace, i + 1);
    }
  }
  return null;
}

describe('list_findings tool schema', () => {
  it('should define list_findings in the TOOLS array', () => {
    const block = extractToolBlock('list_findings');
    expect(block).not.toBeNull();
  });

  it('should require project arg', () => {
    const block = extractToolBlock('list_findings');
    expect(block).toContain('project');
  });

  it('should list status, severity, category, limit as optional filters', () => {
    const block = extractToolBlock('list_findings');
    expect(block).toContain('status');
    expect(block).toContain('severity');
    expect(block).toContain('category');
    expect(block).toContain('limit');
  });

  it('should have a callTool switch case for list_findings', () => {
    expect(toolsSource).toContain("case 'list_findings':");
  });
});

describe('update_finding tool schema', () => {
  it('should define update_finding in the TOOLS array', () => {
    const block = extractToolBlock('update_finding');
    expect(block).not.toBeNull();
  });

  it('should require project and id args', () => {
    const block = extractToolBlock('update_finding');
    expect(block).toContain('project');
    expect(block).toContain('id');
  });

  it('should list status, severity, category as optional update fields', () => {
    const block = extractToolBlock('update_finding');
    expect(block).toContain('status');
    expect(block).toContain('severity');
    expect(block).toContain('category');
  });

  it('should have a callTool switch case for update_finding', () => {
    expect(toolsSource).toContain("case 'update_finding':");
  });
});

describe('create_task_from_finding tool schema', () => {
  it('should define create_task_from_finding in the TOOLS array', () => {
    const block = extractToolBlock('create_task_from_finding');
    expect(block).not.toBeNull();
  });

  it('should require project and id args', () => {
    const block = extractToolBlock('create_task_from_finding');
    expect(block).toContain('project');
    expect(block).toContain('id');
  });

  it('should list agent and priority as optional args', () => {
    const block = extractToolBlock('create_task_from_finding');
    expect(block).toContain('agent');
    expect(block).toContain('priority');
  });

  it('should have a callTool switch case for create_task_from_finding', () => {
    expect(toolsSource).toContain("case 'create_task_from_finding':");
  });
});

describe('imports', () => {
  it('should import patchFindingsConfigMap from @percussionist/kube', () => {
    expect(toolsSource).toContain('patchFindingsConfigMap');
  });

  it('should import getFindingsConfigMap from @percussionist/kube', () => {
    expect(toolsSource).toContain('getFindingsConfigMap');
  });

  it('should import parseTriagedFindings from @percussionist/kube', () => {
    expect(toolsSource).toContain('parseTriagedFindings');
  });

  it('should import FindingStatus, FindingSeverity, FindingCategory from @percussionist/api', () => {
    expect(toolsSource).toContain('FindingStatus');
    expect(toolsSource).toContain('FindingSeverity');
    expect(toolsSource).toContain('FindingCategory');
  });

  it('should import createHash from node:crypto', () => {
    expect(toolsSource).toContain('createHash');
  });

  it('should import type Finding from @percussionist/api', () => {
    expect(toolsSource).toContain('type Finding');
  });
});
