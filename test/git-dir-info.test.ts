import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { branchWebUrl, gitRepoName, parseRemoteUrl, readGitDirInfo, remoteToWebUrl } from '../src/utils/git-dir-info.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: 'pipe', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).toString();

function initRepo(branch = 'main'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gitinfo-')));
  git(dir, 'init', '-q', '-b', branch);
  git(dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

describe('remoteToWebUrl', () => {
  it.each([
    ['git@git.example.com:team/app.git', 'https://git.example.com/team/app'],
    ['git@github.com:deepcoldy/botmux', 'https://github.com/deepcoldy/botmux'],
    ['ssh://git@git.example.com:29418/team/app.git', 'https://git.example.com/team/app'],
    ['https://user:tok@github.com/a/b.git', 'https://github.com/a/b'],
    ['https://github.com/a/b/', 'https://github.com/a/b'],
  ])('%s → %s', (remote, web) => {
    expect(remoteToWebUrl(remote)).toBe(web);
  });

  it('本地路径 / 缺失 → undefined', () => {
    expect(remoteToWebUrl('/srv/repo.git')).toBeUndefined();
    expect(remoteToWebUrl('file:///srv/repo.git')).toBeUndefined();
    expect(remoteToWebUrl(undefined)).toBeUndefined();
  });
});

describe('parseRemoteUrl', () => {
  it('优先 origin，否则取第一个 remote', () => {
    const cfg = '[core]\n\tbare = false\n[remote "up"]\n\turl = git@a:x/up.git\n[remote "origin"]\n\turl = git@a:x/o.git\n';
    expect(parseRemoteUrl(cfg)).toBe('git@a:x/o.git');
    expect(parseRemoteUrl('[remote "up"]\n\turl = git@a:x/up.git\n')).toBe('git@a:x/up.git');
    expect(parseRemoteUrl('[core]\n\turl = nope\n')).toBeUndefined();
  });
});

describe('branchWebUrl', () => {
  it('保留 / ，编码会破坏 markdown 链接的字符', () => {
    expect(branchWebUrl('https://h/g/r', 'feat/skill-category')).toBe('https://h/g/r/tree/feat/skill-category');
    expect(branchWebUrl('https://h/g/r', 'fix/a(b)')).toBe('https://h/g/r/tree/fix/a%28b%29');
    expect(branchWebUrl(undefined, 'main')).toBeUndefined();
  });
});

describe('readGitDirInfo', () => {
  it('普通仓库：分支、远端、子目录向上查找', () => {
    const dir = initRepo('feat/x');
    git(dir, 'remote', 'add', 'origin', 'git@git.example.com:team/app.git');
    execFileSync('mkdir', ['-p', join(dir, 'a/b')]);
    const info = readGitDirInfo(join(dir, 'a/b'))!;
    expect(info.topLevel).toBe(dir);
    expect(info.branch).toBe('feat/x');
    expect(gitRepoName(info)).toBe('app');
  });

  it('git worktree：读 worktree 自己的 HEAD，远端取共享 config，仓库名不是 worktree 目录名', () => {
    const dir = initRepo();
    git(dir, 'remote', 'add', 'origin', 'git@git.example.com:team/app.git');
    const wt = join(realpathSync(mkdtempSync(join(tmpdir(), 'gitinfo-wt-'))), 'app-feat-y');
    git(dir, 'worktree', 'add', '-q', '-b', 'feat/y', wt);
    const info = readGitDirInfo(wt)!;
    expect(info.branch).toBe('feat/y');
    expect(info.remoteUrl).toBe('git@git.example.com:team/app.git');
    expect(gitRepoName(info)).toBe('app');
    expect(info.commonDir).toBe(join(dir, '.git'));
  });

  it('没有远端时仓库名退回主仓库目录名；detached HEAD 没有分支', () => {
    const dir = initRepo();
    const sha = git(dir, 'rev-parse', 'HEAD').trim();
    writeFileSync(join(dir, '.git', 'HEAD'), `${sha}\n`);
    const info = readGitDirInfo(dir)!;
    expect(info.branch).toBeUndefined();
    expect(gitRepoName(info)).toBe(dir.split('/').pop());
  });

  it('不在仓库 → null', () => {
    expect(readGitDirInfo(mkdtempSync(join(tmpdir(), 'nogit-')))).toBeNull();
  });
});
