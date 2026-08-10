import { describe, expect, it } from 'bun:test';
import { buildRepoWebUrl, parseGitHubUrl } from '../index.js';

describe('parseGitHubUrl', () => {
  it('parses SSH form', () => {
    expect(parseGitHubUrl('git@github.com:erkkaha/percussionist.git')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('parses SSH form without .git suffix', () => {
    expect(parseGitHubUrl('git@github.com:erkkaha/percussionist')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('parses HTTPS form', () => {
    expect(parseGitHubUrl('https://github.com/erkkaha/percussionist.git')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('parses HTTPS form without .git suffix', () => {
    expect(parseGitHubUrl('https://github.com/erkkaha/percussionist')).toEqual({
      owner: 'erkkaha',
      repo: 'percussionist',
    });
  });

  it('returns undefined for non-GitHub URLs', () => {
    expect(parseGitHubUrl('git@gitlab.com:erkkaha/percussionist.git')).toBeUndefined();
    expect(parseGitHubUrl('https://gitlab.com/erkkaha/percussionist.git')).toBeUndefined();
  });

  it('returns undefined for empty/unparseable input', () => {
    expect(parseGitHubUrl('')).toBeUndefined();
    expect(parseGitHubUrl('not a url')).toBeUndefined();
  });
});

describe('buildRepoWebUrl', () => {
  it('builds a web URL from SSH form', () => {
    expect(buildRepoWebUrl('git@github.com:erkkaha/percussionist.git')).toBe(
      'https://github.com/erkkaha/percussionist',
    );
  });

  it('builds a web URL from HTTPS form', () => {
    expect(buildRepoWebUrl('https://github.com/erkkaha/percussionist.git')).toBe(
      'https://github.com/erkkaha/percussionist',
    );
  });

  it('returns undefined for non-GitHub URLs', () => {
    expect(buildRepoWebUrl('git@gitlab.com:erkkaha/percussionist.git')).toBeUndefined();
  });

  it('returns undefined for empty input', () => {
    expect(buildRepoWebUrl('')).toBeUndefined();
  });
});
