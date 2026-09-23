import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { branchWebUrl, gitRepoName, readGitDirInfo, remoteToWebUrl, type GitDirInfo } from '../../utils/git-dir-info.js';

/** 目录元数据里按分支记录的链接（`botmux dir set` 写入）。 */
export interface DirLinks { mr?: string; meego?: string }
export type DirLinkKey = keyof DirLinks;
export const DIR_LINK_KEYS: readonly DirLinkKey[] = ['mr', 'meego'];

export interface DirMeta {
  url?: string;
  name?: string;
  /** 分支名 → 该分支的 MR / Meego 链接。按分支存，是为了同一目录切分支后不显示上一个分支的 MR。 */
  branches?: Record<string, DirLinks>;
  /** 不在 git 仓库（或 detached HEAD）时的链接。 */
  links?: DirLinks;
}

export const DIR_META_FILE = '.botmux-dir.json';

/** 卡片签名按哪个目录渲染：agent 声明过的 footerDir 优先，否则会话工作目录。 */
export function brandDirOf(s: { footerDir?: string; workingDir?: string } | undefined): string | undefined {
  return s?.footerDir || s?.workingDir;
}

let cache: { path: string; mtimeMs: number; meta: DirMeta } | null = null;

/**
 * `~` 展开。session.workingDir 可能是**字面量** `~/...`：oncall 绑定（oncallChats /
 * defaultOncall）落盘时存的就是原始字符串，而 resolvePinnedWorkingDir 走 oncallEntry
 * 那一支时不展开。别的消费方都自己展开了（session-manager 给 spawn 的 cwd 用 expandHome），
 * 只有这里漏了 —— statSync('~/x') 必然 ENOENT → 读不到 .botmux-dir.json → 角色名丢失。
 */
function expandHome(p: string): string {
  return p === '~' ? homedir()
    : p.startsWith('~/') ? join(homedir(), p.slice(2))
    : p;
}

function readLinks(v: unknown): DirLinks | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const links: DirLinks = { mr: safeUrl(o.mr), meego: safeUrl(o.meego) };
  return links.mr || links.meego ? links : undefined;
}

/** 读取目录元数据 <workingDir>/.botmux-dir.json（mtime 缓存；缺失/损坏 → {}）。 */
export function readDirMeta(workingDir: string): DirMeta {
  const p = join(expandHome(workingDir), DIR_META_FILE);
  try {
    const st = statSync(p);
    if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs) return cache.meta;
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const branches: Record<string, DirLinks> = {};
    if (raw?.branches && typeof raw.branches === 'object' && !Array.isArray(raw.branches)) {
      for (const [b, v] of Object.entries(raw.branches)) {
        const links = readLinks(v);
        if (links) branches[b] = links;
      }
    }
    const meta: DirMeta = {
      url: safeUrl(raw?.url),
      name: safeName(raw?.name),
      ...(Object.keys(branches).length ? { branches } : {}),
      ...(readLinks(raw) ? { links: readLinks(raw) } : {}),
    };
    cache = { path: p, mtimeMs: st.mtimeMs, meta };
    return meta;
  } catch {
    return {};
  }
}

/**
 * `.botmux-dir.json` 的内容**不可信**：角色名来自用户（「新建角色：XX」），文件本身也只是磁盘上
 * 的任意 JSON；`{cwdName}`/`{cwd}` 的 fallback 更是来自**目录路径**（目录名可含任意字符）。它们
 * 会被拼进卡片脚注，而脚注整体被包进 lark_md 的 `<font color='grey'>…</font>`。不消毒的话：
 *   name = 'x</font><at id=ou_x></at><font>'  → **注入 font/at 标签，能伪造 @提及**
 *   name = 'role]\n**伪造正文**'                → 击穿链接文本位
 *   url  = 'https://x) 尾巴' / 'javascript:…'   → 闭合链接 / 危险 scheme
 */
function safeName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  // **先按码点截断，再转义** —— 顺序很关键：反过来（先转义后截断）会把 `\*` 这类转义序列
  // 从中间切开，留下一个落单的 `\`，它会转义掉模板里紧跟的 `]`/`)`，破坏链接结构。
  // Array.from 按码点切，也顺带避免把 emoji 切成半个代理对。
  const truncated = Array.from(v).slice(0, 64).join('');
  const s = safeText(truncated).trim();
  return s || undefined;
}

/**
 * 文本位消毒。落进脚注的值要同时防两层：
 *   ① lark_md 标签/强调注入 —— 与仓库既有的 `escapeLarkMd`（groups-card.ts:662 等 5 处）对齐：
 *      `&`→`&amp;`（须最先）、`<`→`&lt;`、`>`→`&gt;`、`* _ ~ \`` 反斜杠转义。这层堵死
 *      `</font><at …>` 之类的标签注入。
 *   ② markdown 链接结构 —— 模板是用户可配的，同一个变量既可能落文本位 `[{cwdName}]…`
 *      也可能落 URL 位 `[repo]({cwd})`，所以再剥离 `[ ] ( )`（brand 特有，那 5 个卡片不涉及链接）。
 * 代价：角色名里的 `()[]` 会被丢掉（"客服(测试)"→"客服测试"）—— 有意取舍：宁可掉括号，不可被击穿。
 */
function safeText(s: string): string {
  return s
    .replace(/[\r\n]+/g, ' ')
    // 反斜杠必须**最先**转义 —— 否则 `\*` 里的反斜杠自成偶数对，让紧跟的 `*` 重新变回有效强调。
    // （注：仓库 5 处 escapeLarkMd 拷贝目前都缺这一步，是同一个潜在缺口，可另行加固。）
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([*_~`])/g, '\\$1')
    .replace(/[[\]()]/g, '');
}

/**
 * URL 位：只放行 http/https，且禁掉一串会破坏链接或钓鱼的字符：
 *   - 空白 / `(` `)` / `[` `]` / `<` `>` / 引号反引号 → 闭合链接或注入文本位
 *   - `\` → 在 markdown 里转义掉模板的闭合 `)`
 *   - `@` → userinfo 钓鱼形态 `https://trusted@evil.example/…`（真实 host 是 @ 后面那个）
 *   - host 位（`://` 之后第一个字符）不得再是 `/` → 挡掉 `https:////evil` 归一到 evil 的混淆
 * 用途上这里的 url 只会是飞书知识文档链接（`.../docx/TOKEN`），本就不含上述字符，收紧无副作用。
 * 不合规一律丢弃 → 走既有的空链接降级成纯文本。
 *
 * 已知不处理：IDN/punycode 同形字钓鱼（`https://аррӏе.example`）—— 那是视觉混淆而非结构击穿，
 * 且这里的 url 是 bot 自建知识文档的链接（半可信），不做 IDN 归一。
 */
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return /^https?:\/\/[^\s/()[\]<>"'`\\@][^\s()[\]<>"'`\\@]*$/i.test(s) ? s : undefined;
}

/**
 * 当前目录某条链接（MR / Meego）：在 git 分支上只认该分支名下记录的；不在分支上才用顶层的。
 * 不回落到顶层 —— 否则 canonical 目录切到别的分支后，页脚还挂着上一个分支的 MR。
 */
function linkFor(meta: DirMeta, branch: string | undefined, key: DirLinkKey): string | undefined {
  return branch ? meta.branches?.[branch]?.[key] : meta.links?.[key];
}

const VAR_RE = /\{(cwdName|cwdUrl|cwd|repoUrl|repo|branchUrl|branch|mrUrl|meegoUrl)\}/g;
const GIT_VARS = new Set(['repo', 'repoUrl', 'branch', 'branchUrl', 'mrUrl', 'meegoUrl']);
/** 模板按「 · 」分段；与 buildReplyCardFooter 拼接各段用的分隔符一致。 */
const SEGMENT_SPLIT = /\s+·\s+/;
const SEGMENT_JOIN = ' · ';

/** 模板是否引用了需要 agent 用 `botmux dir set` 写入的链接变量。 */
export function brandTemplateLinkKeys(brand: string | undefined): DirLinkKey[] {
  if (!brand) return [];
  return [
    ...(brand.includes('{mrUrl}') ? ['mr' as const] : []),
    ...(brand.includes('{meegoUrl}') ? ['meego' as const] : []),
  ];
}

/**
 * brandLabel 变量替换：
 *   {cwdName}（元数据 name → basename）、{cwd}、{cwdUrl}
 *   {repo}、{repoUrl}、{branch}、{branchUrl}（读 workingDir 所在 git 仓库）
 *   {mrUrl}、{meegoUrl}（.botmux-dir.json 里当前分支的链接）
 * 仅当模板含 '{' 时激活（存量签名零影响）。模板按「 · 」分段：一段里的变量**全部**为空 →
 * 整段不显示（还没建 MR 时 `[MR]({mrUrl})` 不留一个点不了的「MR」）；部分为空 → 空链接
 * [x]() 降级为纯文本 x（没有 remote 时 `[{repo}]({repoUrl})` 仍显示仓库名）。
 *
 * workingDir 先 expandHome 一次，所有变量共用 —— 否则 {cwdName} 的 basename fallback
 * 与 {cwd} 会吐出字面量 `~`（basename('~') === '~'），与 readDirMeta 读的真实目录不一致。
 */
export function renderBrandTemplate(
  brand: string | undefined,
  workingDir: string | undefined,
): string | undefined {
  if (brand === undefined || !brand.includes('{')) return brand;
  const wd = workingDir ? expandHome(workingDir) : '';
  const meta = wd ? readDirMeta(wd) : {};
  let git: GitDirInfo | null | undefined;
  const gitInfo = (): GitDirInfo | null => (git === undefined ? (git = wd ? readGitDirInfo(wd) : null) : git);
  let repoUrl: string | undefined | null = null;
  const getRepoUrl = (): string | undefined => {
    if (repoUrl === null) repoUrl = safeUrl(remoteToWebUrl(gitInfo()?.remoteUrl));
    return repoUrl;
  };
  const value = (name: string): string => {
    if (!wd) return '';
    if (GIT_VARS.has(name) && !gitInfo() && name !== 'mrUrl' && name !== 'meegoUrl') return '';
    switch (name) {
      case 'cwdName': return meta.name ?? safeText(basename(wd));
      case 'cwd': return safeText(wd);
      case 'cwdUrl': return meta.url ?? '';
      case 'repo': return safeText(gitRepoName(gitInfo()!));
      case 'repoUrl': return getRepoUrl() ?? '';
      case 'branch': return safeText(gitInfo()!.branch ?? '');
      case 'branchUrl': return safeUrl(branchWebUrl(getRepoUrl(), gitInfo()!.branch)) ?? '';
      case 'mrUrl': return linkFor(meta, gitInfo()?.branch, 'mr') ?? '';
      case 'meegoUrl': return linkFor(meta, gitInfo()?.branch, 'meego') ?? '';
      default: return '';
    }
  };
  // 单趟替换：避免已替换进去的值（如 name 含 '{cwd}' 字面量）被后续 pass 二次替换。
  // {cwdName}/{cwd}/{repo}/{branch} 落在链接的**文本位**，而它们来自**目录路径 / git 文件** ——
  // 目录名、分支名都可以含 `]`，照样能击穿 `[...](...)`。所以这些值一律过 safeText，
  // URL 位的值一律过 safeUrl。
  const segments = brand.split(SEGMENT_SPLIT).map((seg) => {
    let vars = 0;
    let filled = 0;
    const rendered = seg.replace(VAR_RE, (_m, name: string) => {
      vars++;
      const v = value(name);
      if (v) filled++;
      return v;
    });
    if (vars > 0 && filled === 0) return '';
    return rendered.replace(/\[([^\]]*)\]\(\)/g, '$1');
  });
  return segments.filter(seg => seg.trim() !== '').join(SEGMENT_JOIN);
}

export type SetDirLinkResult =
  | { ok: true; file: string; branch?: string; /** 在 git 仓库里时：该文件是否已被忽略；不在仓库 → undefined。 */ excluded?: boolean }
  | { ok: false; reason: 'invalid_url' | 'write_failed'; detail?: string };

/**
 * 写 / 清除 `<dir>/.botmux-dir.json` 里当前分支的一条链接，保留文件里的其它字段（name/url/
 * 其它分支）。在 git 仓库里时顺手把该文件加进 `<commonDir>/info/exclude`（只对本机生效，不改
 * 团队的 .gitignore）；已被任何规则忽略则不动。
 */
export function setDirLink(dir: string, key: DirLinkKey, url: string | null): SetDirLinkResult {
  const wd = expandHome(dir);
  const clean = url === null ? null : safeUrl(url);
  if (url !== null && !clean) return { ok: false, reason: 'invalid_url' };
  const file = join(wd, DIR_META_FILE);
  const git = readGitDirInfo(wd);
  const branch = git?.branch;
  try {
    let raw: Record<string, any> = {};
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf-8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch { /* 缺失 / 损坏 → 从空对象开始 */ }
    const target: Record<string, any> = branch
      ? ((raw.branches && typeof raw.branches === 'object' && !Array.isArray(raw.branches)) ? raw.branches : (raw.branches = {}))
      : raw;
    if (branch) {
      const entry = (target[branch] && typeof target[branch] === 'object') ? target[branch] : {};
      if (clean) entry[key] = clean; else delete entry[key];
      if (Object.keys(entry).length) target[branch] = entry; else delete target[branch];
      if (!Object.keys(raw.branches).length) delete raw.branches;
    } else if (clean) {
      raw[key] = clean;
    } else {
      delete raw[key];
    }
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
    renameSync(tmp, file);
  } catch (e: any) {
    return { ok: false, reason: 'write_failed', detail: e?.message ?? String(e) };
  }
  return { ok: true, file, ...(branch ? { branch } : {}), ...(git ? { excluded: ensureGitExcluded(git, wd) } : {}) };
}

/** 尽力而为：文件没被忽略时追加到 info/exclude。任何失败（沙箱不让写 .git 等）都不影响主流程。 */
function ensureGitExcluded(git: GitDirInfo, wd: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', DIR_META_FILE], { cwd: wd, stdio: 'ignore', timeout: 3000 });
    return true; // exit 0 = 已被忽略
  } catch (e: any) {
    if (e?.status !== 1) return false; // 不是「未忽略」而是 git 自身出错 → 不动
  }
  try {
    const infoDir = join(git.commonDir, 'info');
    mkdirSync(infoDir, { recursive: true });
    const exclude = join(infoDir, 'exclude');
    let prev = '';
    try { prev = readFileSync(exclude, 'utf-8'); } catch { /* 不存在 */ }
    appendFileSync(exclude, `${prev && !prev.endsWith('\n') ? '\n' : ''}${DIR_META_FILE}\n`);
    return true;
  } catch {
    return false;
  }
}
