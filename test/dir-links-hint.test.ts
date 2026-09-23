import { describe, expect, it } from 'vitest';
import { buildBotmuxShellHints, buildBotmuxSystemPromptText } from '../src/adapters/cli/shared-hints.js';

const T = '[{repo}]({repoUrl}) · [MR]({mrUrl}) · [Meego]({meegoUrl})';

describe('签名引用 MR/Meego 变量时提示 agent 记录链接', () => {
  it('系统提示：send / transcript 都带，只列出用到的变量', () => {
    const send = buildBotmuxSystemPromptText({ locale: 'zh', brandLabel: T });
    expect(send).toContain('botmux dir set mr');
    expect(send).toContain('botmux dir set meego');
    const onlyMr = buildBotmuxSystemPromptText({ locale: 'zh', brandLabel: '[MR]({mrUrl})', replyDelivery: 'transcript' });
    expect(onlyMr).toContain('botmux dir set mr');
    expect(onlyMr).not.toContain('botmux dir set meego');
  });

  it('未引用 / 未配置 / 无传输会话：不注入', () => {
    expect(buildBotmuxSystemPromptText({ locale: 'zh', brandLabel: '[{cwdName}]({cwdUrl})' })).not.toContain('botmux dir set');
    expect(buildBotmuxSystemPromptText({ locale: 'zh' })).not.toContain('botmux dir set');
    expect(buildBotmuxSystemPromptText({ locale: 'zh', brandLabel: T, noTransport: true })).not.toContain('botmux dir set');
  });

  it('非 injectsSessionContext CLI 的首轮路由提示同样带上', () => {
    expect(buildBotmuxShellHints('zh', false, 'send', T).join('\n')).toContain('botmux dir set mr');
    expect(buildBotmuxShellHints('en', false, 'transcript', T).join('\n')).toContain('botmux dir set meego');
    expect(buildBotmuxShellHints('zh', true, 'send', T).join('\n')).not.toContain('botmux dir set');
    expect(buildBotmuxShellHints('zh', false, 'send').join('\n')).not.toContain('botmux dir set');
  });
});
