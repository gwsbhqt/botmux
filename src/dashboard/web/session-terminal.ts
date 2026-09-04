export interface SessionTerminalLocation {
  protocol: string;
  origin: string;
  hostname: string;
}

function currentLocation(): SessionTerminalLocation | null {
  return typeof window === 'undefined' ? null : window.location;
}

export function sessionTerminalHref(s: any, loc: SessionTerminalLocation | null = currentLocation()): string | null {
  // riff：只读入口对齐飞书卡片语义 —— 「Web终端=日志页」走本地 worker 端口的
  // 只读日志视图，而不是 riffAccessUrl。riffAccessUrl 是 AIO Sandbox 的**可写**
  // capability（bearer URL，见 riff-backend.ts:hashUrlForLog「the unique subdomain
  // IS the write capability」），只能经鉴权的 /write-link（🔑「操作链接=AIO」）下发。
  // 若在此短路返回它，只读图标会打开可写沙箱、且匿名只读面板也会拿到写能力 ——
  // 故这里一律走 webPort 分支，让读/写入口与卡片侧一一对应。
  if (!s?.webPort || !loc) return null;
  // 有 proxy 就一律走同源前门 `/s/<session>`，HTTP 与 HTTPS 不再分叉：
  //  • HTTPS（中心平台机器域名）只反代 443，裸端口是死链；
  //  • HTTP（内网直连 dashboard）以前拼 `hostname:proxyPort` 直连 daemon 的
  //    terminal proxy。那条路有两个坑：绕开前门的 countersign / 撤销检查（与
  //    workbenchTerminalHref 的约定相反），而且 daemon 侧在 upstream 关闭时
  //    destroy 客户端连接，跨网络会截断响应尾部——终端页面 HTML 少几 KB，建
  //    WebSocket 的脚本根本收不到，页面永远停在 connecting（本机 loopback 一次
  //    写完，所以只在远程访问时暴露）。
  if (s.proxyPort) return `${loc.origin}/s/${encodeURIComponent(s.sessionId)}`;
  // 没有 proxy（proxy 没起来 / 老 daemon）才回退裸 worker 端口，且仅限 HTTP：
  // HTTPS 页面上裸端口同样是死链，宁可不给入口。
  return loc.protocol === 'https:' ? null : `http://${loc.hostname}:${s.webPort}`;
}
