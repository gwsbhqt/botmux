/**
 * POST /api/sessions/:sessionId/footer-dir — `botmux dir set` 上报 agent 实际所在的仓库根，
 * 卡片签名改从这里渲染。沙箱内 CLI 读不到 host secret，走 per-turn capability 窄孔；
 * capability 绑定 URL 里的 sessionId。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setIpcAuthSecret, startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import { daemonIpcAuthHeaders } from '../src/core/daemon-ipc-auth.js';
import { repinSessionWorkingDir } from '../src/core/session-cwd.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionStore from '../src/services/session-store.js';
import { config } from '../src/config.js';

const SECRET = 'footer-dir-secret';
const CAP_A = 'ab12cd34'.repeat(8);
const CAP_B = 'ef56ab78'.repeat(8);

let handle: IpcServerHandle | null = null;
let dataDir: string | null = null;
let prevDataDir: string | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  setIpcAuthSecret(null);
  sessionStore.init();
  if (prevDataDir !== null) config.session.dataDir = prevDataDir;
  prevDataDir = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
  vi.restoreAllMocks();
});

function setupStore() {
  dataDir = mkdtempSync(join(tmpdir(), 'ipc-footer-dir-'));
  prevDataDir = config.session.dataDir;
  config.session.dataDir = dataDir;
  sessionStore.init();
  return [
    sessionStore.createSession('oc_fd_a', 'om_fd_a', 'A', 'group'),
    sessionStore.createSession('oc_fd_b', 'om_fd_b', 'B', 'group'),
  ];
}

function activeFor(session: ReturnType<typeof sessionStore.createSession>, capability: string): any {
  return {
    session,
    worker: { killed: false, connected: true, send: vi.fn() },
    workerPort: 1234,
    workerToken: 'token',
    larkAppId: 'app',
    chatId: session.chatId,
    chatType: 'group',
    scope: 'thread',
    spawnedAt: Date.now(),
    cliVersion: '1',
    lastMessageAt: Date.now(),
    hasHistory: true,
    managedTurnOrigin: { capability },
  };
}

async function start(): Promise<void> {
  setIpcAuthSecret(SECRET);
  handle = await startIpcServer({ port: 0, host: '127.0.0.1', authRequired: true });
}

function post(sessionId: string, body: Record<string, unknown>, trustedHost = false): Promise<Response> {
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/footer-dir`;
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (trustedHost) {
    daemonIpcAuthHeaders({ secret: SECRET, port: handle!.port, method: 'POST', path, headers })
      .forEach((value, key) => { headers[key] = value; });
  }
  return fetch(`http://127.0.0.1:${handle!.port}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
}

describe('POST /api/sessions/:sessionId/footer-dir', () => {
  it('沙箱 CLI 凭本会话 capability 写入并持久化', async () => {
    const [a] = setupStore();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) => (id === a.sessionId ? activeFor(a, CAP_A) : undefined));
    await start();
    const dir = mkdtempSync(join(tmpdir(), 'footer-wt-'));
    const res = await post(a.sessionId, { dir, originCapability: CAP_A });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, footerDir: dir });
    expect(sessionStore.getSession(a.sessionId)?.footerDir).toBe(dir);
  });

  it('capability 属于别的会话 → 403，且不写入', async () => {
    const [a, b] = setupStore();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockImplementation((id: string) =>
      (id === a.sessionId ? activeFor(a, CAP_A) : id === b.sessionId ? activeFor(b, CAP_B) : undefined));
    await start();
    const res = await post(a.sessionId, { dir: tmpdir(), originCapability: CAP_B });
    expect(res.status).toBe(403);
    expect(sessionStore.getSession(a.sessionId)?.footerDir).toBeUndefined();
  });

  it('相对路径 / 不存在 / 不是目录 → 400', async () => {
    const [a] = setupStore();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    await start();
    const file = join(mkdtempSync(join(tmpdir(), 'footer-f-')), 'x');
    writeFileSync(file, '');
    for (const dir of ['rel/path', '/definitely/not/here', file, 42]) {
      const res = await post(a.sessionId, { dir }, true);
      expect(res.status).toBe(400);
    }
  });

  it('会话切换工作目录后页脚目录作废', () => {
    vi.spyOn(sessionStore, 'updateSession').mockImplementation(() => {});
    const ds = { workingDir: '/repo/old', session: { sessionId: 's', workingDir: '/repo/old', footerDir: '/repo/wt' } } as any;
    repinSessionWorkingDir(ds, '/repo/new');
    expect(ds.session.footerDir).toBeUndefined();
  });
});
