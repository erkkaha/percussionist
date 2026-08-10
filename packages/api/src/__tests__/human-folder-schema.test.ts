import { describe, expect, it } from 'bun:test';
import { CodeServerSpecSchema, HumanFolderSpecSchema, ProjectSpecSchema } from '../index.js';

describe('HumanFolderSpecSchema', () => {
  it('applies defaults for an empty object', () => {
    expect(HumanFolderSpecSchema.parse({})).toEqual({
      enabled: false,
      name: 'code',
    });
  });

  it('accepts an enabled folder with overrides', () => {
    expect(
      HumanFolderSpecSchema.parse({
        enabled: true,
        name: 'human',
        branch: 'main',
        remoteUrl: 'https://github.com/example/repo.git',
      }),
    ).toEqual({
      enabled: true,
      name: 'human',
      branch: 'main',
      remoteUrl: 'https://github.com/example/repo.git',
    });
  });

  it('keeps optional branch and remoteUrl unset when omitted', () => {
    const parsed = HumanFolderSpecSchema.parse({ enabled: true });
    expect(parsed.branch).toBeUndefined();
    expect(parsed.remoteUrl).toBeUndefined();
  });

  it('parses correctly nested under codeServer', () => {
    const parsed = CodeServerSpecSchema.parse({
      enabled: true,
      humanFolder: { enabled: true },
    });
    expect(parsed.humanFolder).toEqual({ enabled: true, name: 'code' });
  });

  it('leaves humanFolder undefined when omitted', () => {
    expect(CodeServerSpecSchema.parse({ enabled: true }).humanFolder).toBeUndefined();
  });

  it('accepts a full project spec with humanFolder', () => {
    const parsed = ProjectSpecSchema.parse({
      source: {
        git: {
          url: 'https://github.com/example/repo.git',
          ref: 'main',
        },
      },
      codeServer: {
        enabled: true,
        humanFolder: { enabled: true },
      },
    });
    expect(parsed.codeServer?.humanFolder).toEqual({ enabled: true, name: 'code' });
  });
});
