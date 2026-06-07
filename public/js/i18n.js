/**
 * Lightweight i18n for Nanocode.
 * Usage: import { t, setLang, applyI18n } from './i18n.js'
 * Elements with data-i18n="key" get their textContent replaced.
 * Elements with data-i18n-title="key" get their title replaced.
 * Elements with data-i18n-placeholder="key" get their placeholder replaced.
 */

const LANG_KEY = 'nanocodeLang'

const translations = {
  en: {
    // Header
    'header.status.bash': 'Bash: disconnected',
    // Settings panel
    'settings.title': 'Settings',
    'settings.close': 'Close',
    // Language
    'settings.language': 'Language',
    // Sections
    'settings.section.session': 'Session',
    'settings.section.display': 'Display',
    'settings.section.monitor': 'Monitor',
    // Session subsections
    'settings.rendermode.claude.label': 'Render mode (claude tab)',
    'settings.rendermode.claude.hint': 'block=rich text / terminal=PTY fallback',
    'settings.rendermode.claude.block': 'Block (default, rich text)',
    'settings.rendermode.claude.terminal': 'Terminal (PTY raw, fallback)',
    'settings.rendermode.codex.label': 'Render mode (codex tab)',
    'settings.rendermode.codex.hint': 'terminal=PTY raw, stable / block=experimental rich text',
    'settings.rendermode.codex.terminal': 'Terminal (default, PTY raw)',
    'settings.rendermode.codex.block': 'Block (experimental, rich text+fold)',
    'settings.autoresume.label': 'Auto-Resume',
    'settings.autoresume.hint': 'Auto --continue when claude exits',
    'settings.autoresume.toggle': 'Enable auto-resume (3s countdown, cancelable)',
    'settings.auth.label': 'Account Status',
    'settings.auth.hint': 'claude auth status',
    'settings.auth.loading': 'Loading…',
    'settings.claude.model.label': 'Claude Model',
    'settings.claude.model.hint': 'Empty = CLI default',
    'settings.claude.model.default': 'Default (CLI decides)',
    'settings.effort.label': 'Effort Level',
    'settings.effort.hint': 'Empty = CLI default',
    'settings.effort.default': 'Default',
    // Global permission
    'settings.permission.label': 'Permission Mode',
    'settings.permission.hint': 'Applies to both Claude and Codex. Takes effect on next session.',
    'settings.permission.full-auto': 'Full Auto (default) — skip all confirmations',
    'settings.permission.auto-edits': 'Auto Edits — apply edits, ask for shell commands',
    'settings.permission.ask': 'Ask / Careful — confirm every action',
    // Codex model
    'settings.codex.model.label': 'Codex Model',
    'settings.codex.model.hint': 'Empty = Codex default',
    'settings.codex.model.default': 'Default (Codex decides)',
    // Display subsections
    'settings.toolfold.label': 'Tool block folding',
    'settings.toolfold.full': 'Full (tool name + content)',
    'settings.toolfold.header': 'Header only',
    'settings.toolfold.line': 'Line (collapsed to bar)',
    'settings.subagent.label': 'Subagent Visibility',
    'settings.subagent.hint': 'Takes effect immediately',
    'settings.subagent.prompt': 'Show prompts sent to subagents',
    'settings.subagent.activity': 'Show subagent activity (verbose, off by default)',
    'settings.fontsize.label': 'Terminal font size',
    // Monitor subsections
    'settings.services.label': 'Port Health',
    'settings.services.hint': 'Checked every 30s',
    'settings.services.add': '+ Add',
    'settings.ntfy.label': 'ntfy Push',
    'settings.ntfy.hint': 'Leave blank to disable',
    'settings.ntfy.url': 'Server URL',
    'settings.ntfy.topic': 'Topic',
    'settings.ntfy.test': 'Test',
    'settings.notify.label': 'Notification Sounds',
    'settings.notify.enabled': 'Enable sounds (done / blocked / QA)',
    'settings.notify.volume': 'Volume',
    'settings.notify.done': 'Done',
    'settings.notify.blocked': 'Blocked',
    'settings.notify.qa': 'QA',
    'settings.notify.turn_threshold_label': 'Turn complete alert threshold (s)',
    'settings.notify.turn_threshold_hint': 'Notify when turn exceeds this many seconds',
    'settings.notify.turn_ntfy_label': 'Push turn-complete via ntfy',
    'settings.tts.label': 'TTS (GPT-SoVITS)',
    'settings.tts.enabled': 'Enable TTS',
    'settings.tts.streaming': 'Streaming mode (low latency)',
    'settings.tts.refaudio': 'Reference audio path',
    'settings.tts.prompttext': 'Reference text',
    'settings.tts.debuglog': 'TTS Debug Log',
    // Common buttons
    'btn.save': 'Save',
    'btn.test': 'Test',
    // Chat input
    'chat.placeholder.claude': 'Message Claude… (/ for commands)',
    'chat.placeholder.codex': 'Send to Codex… (/ for codex commands)',
    'chat.placeholder.default': 'Type a command...',
    'chat.send_now': 'Send now',
    'chat.stop': 'Stop',
    // Queue tray
    'queue.header': 'Queued',
    'queue.hint': '↑ Edit and requeue · Auto-sent when Claude is idle',
    'queue.send_now.title': 'Interrupt current turn and send all queued messages immediately',
    // TTS button
    'tts.on': 'Text-to-Speech (on)',
    'tts.off': 'Text-to-Speech (off)',
    // Mute button
    'mute.on': 'Muted — click to unmute',
    'mute.off': 'Sound on — click to mute',
  },
  zh: {
    // Header
    'header.status.bash': 'Bash: 未连接',
    // Settings panel
    'settings.title': '设置',
    'settings.close': '关闭',
    // Language
    'settings.language': '语言',
    // Sections
    'settings.section.session': '会话',
    'settings.section.display': '显示',
    'settings.section.monitor': '服务监控',
    // Session subsections
    'settings.rendermode.claude.label': '渲染模式 (claude tab)',
    'settings.rendermode.claude.hint': 'block=富文本 / terminal=PTY 兜底',
    'settings.rendermode.claude.block': 'Block（默认，富文本）',
    'settings.rendermode.claude.terminal': 'Terminal（PTY raw，兜底）',
    'settings.rendermode.codex.label': '渲染模式 (codex tab)',
    'settings.rendermode.codex.hint': 'terminal=PTY raw 最稳 / block=实验性富文本',
    'settings.rendermode.codex.terminal': 'Terminal（默认，PTY raw 兜底）',
    'settings.rendermode.codex.block': 'Block（实验，富文本+折叠）',
    'settings.autoresume.label': 'Auto-Resume',
    'settings.autoresume.hint': 'claude 退出后自动 --continue',
    'settings.autoresume.toggle': '启用 auto-resume（3s 倒计时可取消）',
    'settings.auth.label': '账号状态',
    'settings.auth.hint': 'claude auth status',
    'settings.auth.loading': '加载中…',
    'settings.claude.model.label': 'Claude 模型',
    'settings.claude.model.hint': '空=CLI 默认',
    'settings.claude.model.default': '默认（CLI 决定）',
    'settings.effort.label': 'Effort 级别',
    'settings.effort.hint': '空=CLI 默认',
    'settings.effort.default': '默认',
    // Global permission
    'settings.permission.label': 'Permission 模式',
    'settings.permission.hint': '同时驱动 Claude 和 Codex，下次会话生效。',
    'settings.permission.full-auto': 'Full Auto（默认）——跳过所有确认',
    'settings.permission.auto-edits': 'Auto Edits——自动编辑，Shell 命令需确认',
    'settings.permission.ask': 'Ask / 谨慎——每步确认',
    // Codex model
    'settings.codex.model.label': 'Codex 模型',
    'settings.codex.model.hint': '空=Codex 默认',
    'settings.codex.model.default': '默认（Codex 决定）',
    // Display subsections
    'settings.toolfold.label': 'Tool block 折叠',
    'settings.toolfold.full': 'Full（工具名+内容）',
    'settings.toolfold.header': 'Header only（只显示工具名）',
    'settings.toolfold.line': 'Line（折叠为细条）',
    'settings.subagent.label': 'Subagent 可见性',
    'settings.subagent.hint': '立即生效',
    'settings.subagent.prompt': '显示发给 subagent 的 prompt',
    'settings.subagent.activity': '显示 subagent 活动（通常较冗长，默认关）',
    'settings.fontsize.label': '终端字号',
    // Monitor subsections
    'settings.services.label': '端口健康',
    'settings.services.hint': '每 30s 检查',
    'settings.services.add': '+ 添加',
    'settings.ntfy.label': 'ntfy 推送',
    'settings.ntfy.hint': '留空禁用',
    'settings.ntfy.url': '服务器 URL',
    'settings.ntfy.topic': 'Topic',
    'settings.ntfy.test': '测试',
    'settings.notify.label': '通知音效',
    'settings.notify.enabled': '启用音效（done / blocked / QA）',
    'settings.notify.volume': '音量',
    'settings.notify.done': 'Done',
    'settings.notify.blocked': 'Blocked',
    'settings.notify.qa': 'QA',
    'settings.notify.turn_threshold_label': 'Turn 完成提醒阈值（秒）',
    'settings.notify.turn_threshold_hint': '超过此秒数时通知',
    'settings.notify.turn_ntfy_label': 'Turn 完成推送 ntfy',
    'settings.tts.label': 'TTS（GPT-SoVITS）',
    'settings.tts.enabled': '启用 TTS',
    'settings.tts.streaming': '流式模式（低延迟）',
    'settings.tts.refaudio': '参考音频路径',
    'settings.tts.prompttext': '参考文本',
    'settings.tts.debuglog': 'TTS 调试日志',
    // Common buttons
    'btn.save': '保存',
    'btn.test': '测试',
    // Chat input
    'chat.placeholder.claude': '发消息给 Claude…（/ 触发命令）',
    'chat.placeholder.codex': '发消息给 Codex…（/ 触发 codex 命令）',
    'chat.placeholder.default': '输入命令…',
    'chat.send_now': '立刻发送',
    'chat.stop': '停止',
    // Queue tray
    'queue.header': '排队中',
    'queue.hint': '↑ 取回编辑 · Claude 空闲时自动发送',
    'queue.send_now.title': '中断当前回合，立即发送所有排队消息',
    // TTS button
    'tts.on': '语音合成（开启）',
    'tts.off': '语音合成（关闭）',
    // Mute button
    'mute.on': '已静音——点击取消',
    'mute.off': '声音开——点击静音',
  },
}

let _currentLang = 'en'

export function getLang() {
  return _currentLang
}

export function t(key) {
  return (translations[_currentLang] && translations[_currentLang][key]) ||
    (translations['en'] && translations['en'][key]) ||
    key
}

export function setLang(lang) {
  if (!translations[lang]) lang = 'en'
  _currentLang = lang
  try { localStorage.setItem(LANG_KEY, lang) } catch {}
  applyI18n()
}

export function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n')
    if (key) el.textContent = t(key)
  })
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title')
    if (key) el.title = t(key)
  })
  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder')
    if (key) el.placeholder = t(key)
  })
}

export function initI18n() {
  let lang = 'en'
  try { lang = localStorage.getItem(LANG_KEY) || 'en' } catch {}
  if (!translations[lang]) lang = 'en'
  _currentLang = lang
  applyI18n()
}
