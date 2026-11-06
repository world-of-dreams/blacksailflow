#!/usr/bin/env node
/**
 * 【常驻规则】原生 hook 脚本 —— SessionStart 与 UserPromptSubmit **共用本文件、同一来源**。
 *
 * 来源（唯一来源）：`hooks/resident-rules.md`，运行时读取；路径由本脚本位置推出
 *   （<本文件目录>/../../hooks/resident-rules.md，即项目根 hooks/resident-rules.md）。
 * 维护方式：规则正文只改 `hooks/resident-rules.md`；本脚本不存规则文本、不需要重新生成，
 *   每次调用重新读盘，改盘即生效（外部进程每次新起，不随宿主模块加载缓存）。
 * 注入区段：从文件中的「【常驻规则】」标记起到文件末尾，逐字节（含末尾换行）；
 *   标记之前的 Markdown 标题是文档元信息，不注入。因此注入文本 = `hooks/resident-rules.md`
 *   的规则区段原文，不做空白/换行归一。
 * 读失败：文件缺失、不可读或找不到「【常驻规则】」标记 → 输出 `{}`、exit 0（fail-open：
 *   本回合不注入，但不阻塞任何回合）。此处不另写内联副本兜底 —— 宁可这一回合没有常驻规则，
 *   也不让规则出现第二来源。读失败也不写入去重状态，恢复后下一回合即可正常注入。
 *
 * 输出契约（依据 @deepseek-ai/dsh-hook-protocol lib/index.js applyStructured()）：
 *   additionalContext 只从 hookSpecificOutput.additionalContext 读取，且
 *   hookSpecificOutput.hookEventName 必须等于实际事件名，否则该字段被丢弃 —— 因此必须回显事件名。
 *   stdout 单行 JSON，exit 0（非 2 的任何退出码都是非阻塞失败，不会注入）。
 *
 * 事件名来源优先级：--event=<Name> 参数（hooks.json 显式传入，确定性）
 *                   → stdin JSON 的 hook_event_name（Claude Code 协议字段，作为兼容回退）。
 * stdin 始终被排空（避免写入端 EPIPE），最多等 2000ms。
 *
 * 去重（v3，2026-11-01 收紧；v2 = 会话级冷却 + 空 prompt 一律 fail-open）：
 *   实测：同一 turn 内收到第二条 inbox 消息时桥会在该 turn 再发一次 pre-step
 *   （桥源码 hooks-claude-code lib/index.js L232-247：UserPromptSubmit 挂在 agent/pre-step，
 *     payload.prompt = blocksToText(该步 messages 的 text 块)，L344-346/L361-365）。
 *   v2 在「第二次声明的 payload 无 prompt」时会 fail-open 再注入一份（member turn 27/28/29 实测）。
 *
 *   v3 规则（状态按 session_id 记 injectedAt = 最近一次**实际注入**时间）：
 *   ① 缺 session_id → 直接注入（无法定位会话，fail-open）。
 *   ② SessionStart → 永远注入（每会话一次的基线），且这次注入也写入状态，供保底窗使用。
 *   ③ UserPromptSubmit + 非空 prompt → 距上次注入 ≥ COOLDOWN_MS 才注入（正常回合恰好一份）。
 *   ④ UserPromptSubmit + 空 prompt → 距上次注入 ≥ STALE_MS（X）才注入一次（保底）。
 *   ⑤ 状态读写异常一律 fail-open（宁可多注入，也不静默丢纪律）。
 *   ⑥ 事件名不可判定 → 输出 {}（不注入、不阻塞）。
 *   常量取值理由见 investigation/native-hooks-20261101.md「v3」段（按真实回合间隔定标）。
 *
 * 状态文件：默认 <DSH_HOME>/profiles/desktop/hooks/.task-discipline-state.json。
 *   环境变量 `BSF_TASK_DISCIPLINE_STATE` 可覆盖，仅供 harness 指向临时文件（生产 hooks.json
 *   不设该变量，生产行为不受影响）。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HOOK_DIR, HOOK_STATE_DIR } from '../paths.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RULES_FILE = join(HOOK_DIR, 'resident-rules.md');
const RULES_MARKER = '【常驻规则】';
const STATE_FILE = process.env.BSF_TASK_DISCIPLINE_STATE
  || join(HOOK_STATE_DIR, 'task-discipline-state.json');
/**
 * 真回合去重窗（ms）：距上次注入 < COOLDOWN_MS 的非空 prompt 声明视为同一回合的重复声明。
 * 定标：同一 turn 内两次声明的实测最大间隔 45312ms（member turn 28）×1.32 ≈ 60s；
 *       真实相邻回合的最小间隔实测 73100ms（turn 31→32），60s 仍留 13s 余量。
 */
const COOLDOWN_MS = 60000;
/**
 * 空 prompt 保底窗（ms，v3 的 X）：距上次注入 ≥ STALE_MS 才允许空 prompt 注入一次。
 * 定标：> 2× 实测同回合最大间隔（45312ms），保证同回合内的空 prompt 声明不会补第二份；
 *       同时给「payload 永远为空」的会话一个上界（最多 1 份/2 分钟，而不是每步一份）。
 */
const STALE_MS = 120000;
/** 状态条目保留时长（ms）。 */
const STATE_TTL_MS = 600000;
const MAX_STATE_ENTRIES = 300;

const KNOWN_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);

function eventFromArgv(argv) {
  for (const arg of argv) {
    if (typeof arg === 'string' && arg.startsWith('--event=')) return arg.slice('--event='.length);
  }
  return '';
}

/** 排空 stdin 并返回原始文本（最多等 maxWaitMs，永不抛）。 */
async function readStdin(maxWaitMs = 2000) {
  return await new Promise((resolve) => {
    let settled = false;
    const chunks = [];
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(''), maxWaitMs);
    timer.unref?.();
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', (chunk) => chunks.push(chunk));
      process.stdin.on('end', () => finish(chunks.join('')));
      process.stdin.on('error', () => finish(''));
      process.stdin.resume();
    } catch {
      finish('');
    }
  });
}

function payloadFrom(raw) {
  if (!raw || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** 读常驻规则原文：返回「【常驻规则】」标记到文件末尾的逐字节切片；读不到返回空串。 */
function readResidentRules() {
  try {
    const raw = readFileSync(RULES_FILE, 'utf8');
    const start = raw.indexOf(RULES_MARKER);
    return start >= 0 ? raw.slice(start) : '';
  } catch {
    return '';
  }
}

/**
 * 注入裁决：返回 true = 本次应注入。规则见文件头 ①–⑥。
 * 状态字段：at = 最近一次裁决时间（TTL 用）；injectedAt = 最近一次实际注入时间（窗口基准）；
 *          injected = 本次是否注入；promptChars = 本次 payload.prompt 长度。
 */
function decideInjection(sessionId, eventName, promptText) {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return true;
  const now = Date.now();
  let state = {};
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed;
  } catch {
    state = {};
  }
  const previous = state[sessionId];
  // 兼容 v2 状态条目（无 injectedAt）：v2 的 at 在 injected:true 时就是真实注入时间，
  // 沿用它可以避免升级后的第一个回合被多注入一份。
  const lastInjectedAt = previous && Number.isFinite(previous.injectedAt)
    ? previous.injectedAt
    : (previous && previous.injected === true && Number.isFinite(previous.at) ? previous.at : 0);
  const hasPrompt = typeof promptText === 'string' && promptText.length > 0;
  let inject;
  if (eventName === 'SessionStart') inject = true;
  else if (hasPrompt) inject = lastInjectedAt === 0 || now - lastInjectedAt >= COOLDOWN_MS;
  else inject = lastInjectedAt === 0 || now - lastInjectedAt >= STALE_MS;
  state[sessionId] = {
    at: now,
    event: eventName,
    promptChars: hasPrompt ? promptText.length : 0,
    injected: inject,
    injectedAt: inject ? now : lastInjectedAt,
  };

  for (const key of Object.keys(state)) {
    const at = state[key] && Number.isFinite(state[key].at) ? state[key].at : 0;
    if (now - at > STATE_TTL_MS) delete state[key];
  }
  const keys = Object.keys(state);
  if (keys.length > MAX_STATE_ENTRIES) {
    keys.sort((a, b) => (state[a]?.at ?? 0) - (state[b]?.at ?? 0));
    for (const key of keys.slice(0, keys.length - MAX_STATE_ENTRIES)) delete state[key];
  }
  try {
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8');
  } catch {
    return true;
  }
  return inject;
}

const rawPayload = await readStdin();
const payload = payloadFrom(rawPayload);
const eventName = eventFromArgv(process.argv.slice(2)) || (typeof payload.hook_event_name === 'string' ? payload.hook_event_name : '');
const promptText = typeof payload.prompt === 'string' ? payload.prompt : '';
const residentRules = KNOWN_EVENTS.has(eventName) ? readResidentRules() : '';
if (!KNOWN_EVENTS.has(eventName)) {
  // 事件名不可判定：不输出上下文（退出码 0，不阻塞任何回合）。
  process.stdout.write('{}\n');
} else if (residentRules.length === 0) {
  // 规则来源读不到：fail-open 输出空对象（不注入、不阻塞），不占用去重窗口。
  process.stdout.write('{}\n');
} else if (!decideInjection(payload.session_id, eventName, promptText)) {
  // 判定为同一回合内的重复触发（或空 prompt 且未到保底窗）：不再注入第二份。
  process.stdout.write('{}\n');
} else {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: residentRules },
  }) + '\n');
}
