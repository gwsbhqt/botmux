/**
 * 不起 git 子进程、直接读 `.git` 里的文件拿仓库名 / 分支 / 远端网页地址。
 *
 * 用在卡片脚注（brandLabel 的 {repo}/{branch}/… 变量）这种每发一张卡都会走的热路径上：
 * `git rev-parse` 一次几十毫秒，还可能被 hooks / 巨型仓库拖慢；读 HEAD + config 两个小文件
 * 是微秒级。代价是只覆盖常见形态（普通仓库、`git worktree`、子目录），不追 `includeIf`、
 * `extensions.worktreeConfig` 这类少见配置 —— 读不到就返回 undefined，调用方按「没有」处理。
 */
import { readFileSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

export interface GitDirInfo {
  /** 工作树根目录（含 `.git` 的那一层）。 */
  topLevel: string;
  /** 本工作树私有的 git 目录（worktree 时是 `<common>/worktrees/<name>`）。 */
  gitDir: string;
  /** 所有 worktree 共享的 git 目录（config / info/exclude 在这里）。 */
  commonDir: string;
  /** 当前分支名；detached HEAD 时 undefined。 */
  branch?: string;
  /** origin（没有则第一个 remote）的原始 url。 */
  remoteUrl?: string;
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function readText(p: string): string | undefined {
  try { return readFileSync(p, 'utf-8'); } catch { return undefined; }
}

/** 从 `.git` 文件（worktree / submodule）解析出真实 git 目录。 */
function resolveGitFile(dotGit: string): string | undefined {
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(readText(dotGit) ?? '');
  if (!m) return undefined;
  const p = isAbsolute(m[1]) ? m[1] : resolve(dirname(dotGit), m[1]);
  return isDir(p) ? p : undefined;
}

/** 解析 git config 里 origin（缺省取第一个 remote）的 url。只认最常见的 `[remote "x"]` + `url =`。 */
export function parseRemoteUrl(configText: string): string | undefined {
  let current: string | undefined;
  const urls = new Map<string, string>();
  for (const rawLine of configText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const section = /^\[\s*remote\s+"([^"]+)"\s*\]$/.exec(line);
    if (section) { current = section[1]; continue; }
    if (line.startsWith('[')) { current = undefined; continue; }
    if (!current || urls.has(current)) continue;
    const kv = /^url\s*=\s*(.+)$/.exec(line);
    if (kv) urls.set(current, kv[1].replace(/^"(.*)"$/, '$1').trim());
  }
  return urls.get('origin') ?? urls.values().next().value;
}

/** 从 `dir` 往上找 git 工作树；不在仓库里返回 null。 */
export function readGitDirInfo(dir: string): GitDirInfo | null {
  let cur = resolve(dir);
  for (;;) {
    const dotGit = join(cur, '.git');
    const gitDir = isDir(dotGit) ? dotGit : resolveGitFile(dotGit);
    if (gitDir) {
      const commonRel = readText(join(gitDir, 'commondir'))?.trim();
      const commonDir = commonRel ? resolve(gitDir, commonRel) : gitDir;
      const head = readText(join(gitDir, 'HEAD'))?.trim() ?? '';
      const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      const config = readText(join(commonDir, 'config'));
      return {
        topLevel: cur,
        gitDir,
        commonDir,
        branch: ref ? ref[1] : undefined,
        remoteUrl: config ? parseRemoteUrl(config) : undefined,
      };
    }
    const parent = dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

/**
 * 远端 url → 仓库网页地址：
 *   git@host:group/repo.git            → https://host/group/repo
 *   ssh://git@host[:port]/group/repo   → https://host/group/repo（SSH 端口不是网页端口，丢掉）
 *   https://user@host/group/repo.git   → https://host/group/repo（去掉 userinfo）
 * 本地路径 / file:// 等认不出的形态 → undefined。
 */
export function remoteToWebUrl(remote: string | undefined): string | undefined {
  if (!remote) return undefined;
  const s = remote.trim();
  let host: string | undefined;
  let path: string | undefined;
  let m = /^[^@\s/]+@([^:\s/]+):(?!\/)(.+)$/.exec(s);           // scp 形态
  if (m) { host = m[1]; path = m[2]; }
  if (!host) {
    m = /^(?:ssh|git\+ssh|https?|git):\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/i.exec(s);
    if (m) { host = m[1]; path = m[2]; }
  }
  if (!host || !path) return undefined;
  const cleanPath = path.replace(/\/+$/, '').replace(/\.git$/i, '');
  if (!cleanPath) return undefined;
  return `https://${host}/${cleanPath}`;
}

/** 仓库名：优先远端路径最后一段（worktree 目录名常是 `app-feat-x`，不是仓库名），
 *  没有远端时退回主仓库目录名。 */
export function gitRepoName(info: GitDirInfo): string {
  const web = remoteToWebUrl(info.remoteUrl);
  if (web) return basename(web);
  return basename(basename(info.commonDir) === '.git' ? dirname(info.commonDir) : info.topLevel);
}

/** 分支网页地址 `<repoUrl>/tree/<branch>`（GitHub 与 Codebase 同一形态）。
 *  分支名逐段 percent-encode，保留 `/`；额外编码 `()'*!` —— encodeURIComponent 不管它们，
 *  而 `(` `)` 会闭合 markdown 链接。 */
export function branchWebUrl(repoUrl: string | undefined, branch: string | undefined): string | undefined {
  if (!repoUrl || !branch) return undefined;
  const encoded = branch.split('/').map(seg =>
    encodeURIComponent(seg).replace(/[()'*!]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`),
  ).join('/');
  return `${repoUrl}/tree/${encoded}`;
}
