#!/usr/bin/env node
/**
 * Stop 钩子：回合结束时的自主循环检查（判交付达标，不只判 running）。
 *
 * 依据：
 *   - 桥接插件 @deepseek-ai/dsh-hooks-claude-code lib/index.js L297-313：
 *     Stop 事件挂在 agent/turn-stopping；decision=deny 时用 agent.steer() 强制继续。
 *   - 输出协议 @deepseek-ai/dsh-hook-protocol lib/index.js L232-250：
 *     顶层 {"decision":"block","reason":"..."} 合并为 deny。
 *   - Stop payload 只有 session_id（同文件 L357-362 base()、L393-398 stopPayload()），没有 agent 身份字段。
 *   - 行为规格：hooks/11-三档工作方式与自主循环规格.md §二。
 *
 * 行为：
 *   1. 只判本会话自己名下的 running 任务（owner 判定见下）；别人的、非 running 的不判。
 *   2. 对这些任务逐条执行 acceptance[i].verify.command（cwd=verify.cwd）：
 *      全部 exit 0 = 达标 → 放行；任一非 0/超时/缺 verify/超预算 = 未达标 → decision:block，
 *      理由点名「任务 id + 第几条 check + 命令 + exit code」。
 *   3. 预算：每会话最多判 MAX_TASKS 个任务，每条命令 CMD_TIMEOUT_MS 超时，
 *      全部判定总预算 TOTAL_BUDGET_MS；超预算的条目按未达标写「未能判定（预算不足）」。
 *      hooks.json Stop timeout=15s，最坏 2s(stdin) + 9s(判定) < 15s。
 *   4. 同一会话最多拦 MAX_BLOCKS 次、两次之间至少间隔 COOLDOWN_MS，防止空转；
 *      冷却中或次数用尽则放行，不再起判定进程。
 *   5. 任何异常一律放行（输出 {}），绝不阻塞正常结束。
 *
 * 自己名下的判定依据（只看 owner 字段）：
 *   1. owner === 本会话 session_id；
 *   2. owner 形如 `hand:<hex>` 且本会话 id 以该 hex 开头（hand 的 owner 用会话 id 前 8 位，
 *      例：hand:0eaf3fd7 ↔ 0eaf3fd7-4def-46e7-8b55-d05de5ac8fdf）；
 *   3. owner 等于本会话的 teammate 名：从本会话头取 parentSession（团队根会话 id），
 *      在该根会话日志的 `team/member` 事件里按 member.id === 本会话 id 取 name；
 *   4. 本会话没有 parentSession（团队根会话）时，owner === 'lead'。
 *   名称取不到时退化为 1、2 两条（只按 id 相关拦），不对“可能属于我”的名字做猜测。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

import { BOARD_PATH, HOOK_STATE_DIR, SESSIONS_ROOT as SESSIONS_ROOT_PATH } from '../paths.mjs';

const MANIFEST = process.env.BSF_MANIFEST || BOARD_PATH;
const STATE = process.env.BSF_STOP_STATE || join(HOOK_STATE_DIR, 'stop-autoloop-state.json');
const SESSIONS_ROOT = process.env.BSF_SESSIONS_ROOT || SESSIONS_ROOT_PATH;
const MAX_BLOCKS = 2;
const COOLDOWN_MS = 60000;
const STATE_TTL_MS = 3600000;
const MAX_ENTRIES = 200;
const MAX_TASKS = 2;
const CMD_TIMEOUT_MS = 4000;
const TOTAL_BUDGET_MS = 9000;

function readStdin(maxWaitMs = 2000) {
  return new Promise((resolve) => {
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

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 解 zstd 多帧文本：会话日志逐帧追加，正在写的那一帧解不开就跳过前面的帧照用。 */
function readFrames(path) {
  const buf = readFileSync(path);
  const starts = [];
  let at = 0;
  while ((at = buf.indexOf(ZSTD_MAGIC, at)) !== -1) {
    starts.push(at);
    at += ZSTD_MAGIC.length;
  }
  let text = '';
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try {
      text += zstdDecompressSync(buf.subarray(starts[i], end)).toString('utf8');
    } catch {
      // 半帧，跳过。
    }
  }
  return text;
}

/** 会话目录 = `${project}/${sessionId}`；project 段编码规则归宿主，这里按 id 扫一遍。 */
function findSessionDir(sessionId) {
  try {
    for (const project of readdirSync(SESSIONS_ROOT)) {
      const dir = join(SESSIONS_ROOT, project, sessionId);
      if (existsSync(join(dir, 'session.v4.jsonl.zstd'))) return dir;
    }
  } catch {
    // 读不到就当作对自己的名一无所知。
  }
  return undefined;
}

/** 本会话自己名下的 owner 名称集合（判定依据 3、4）；取不到就是空集。 */
function ownNames(sessionId) {
  const names = new Set();
  const dir = findSessionDir(sessionId);
  if (!dir) return names;
  let header;
  try {
    header = JSON.parse(
      zstdDecompressSync(readFileSync(join(dir, 'session.v4.jsonl.zstd')))
        .toString('utf8')
        .split('\n')[0],
    );
  } catch {
    return names;
  }
  if (!header?.parentSession) {
    names.add('lead');
    return names;
  }
  const parentDir = findSessionDir(header.parentSession);
  if (!parentDir) return names;
  for (const line of readFrames(join(parentDir, 'session.v4.jsonl.zstd')).split('\n')) {
    if (!line.includes('"team/member"')) continue;
    try {
      const member = JSON.parse(line)?.data?.member;
      if (member?.id === sessionId && typeof member.name === 'string' && member.name) {
        names.add(member.name);
      }
    } catch {
      // 坏行跳过。
    }
  }
  return names;
}

/** owner 是否属于本会话（判定依据 1、2 加名称集合）。 */
function ownsTask(task, sessionId, names) {
  const owner = String(task?.owner ?? '').trim();
  if (!owner) return false;
  if (owner === sessionId || names.has(owner)) return true;
  if (!owner.startsWith('hand:')) return false;
  const idPrefix = owner.slice('hand:'.length);
  return idPrefix.length > 0 && sessionId.startsWith(idPrefix);
}

/** 跑一条 verify 命令；返回 {outcome:'pass'|'exit'|'timeout'|'spawn'}。 */
function runVerify(command, cwd, timeoutMs) {
  let result;
  try {
    result = spawnSync(command, {
      cwd,
      shell: true,
      timeout: timeoutMs,
      stdio: 'ignore',
      windowsHide: true,
      env: process.env,
    });
  } catch (error) {
    return { outcome: 'spawn', error: error?.code ?? error?.message ?? 'spawn error' };
  }
  if (result.error && (result.error.code === 'ETIMEDOUT' || result.signal === 'SIGTERM')) {
    return { outcome: 'timeout', timeoutMs };
  }
  if (result.error && result.status === null) {
    return { outcome: 'spawn', error: result.error.code ?? result.error.message ?? 'spawn error' };
  }
  if (result.status === 0) return { outcome: 'pass' };
  return { outcome: 'exit', code: result.status ?? result.signal ?? 'unknown' };
}

/** 逐条判定本会话名下 running 任务的 acceptance verify，返回未达标项。 */
function judgeDelivery(running) {
  const failures = [];
  const budgetStart = Date.now();
  const remaining = () => TOTAL_BUDGET_MS - (Date.now() - budgetStart);

  // 超出每会话判定上限的任务：无法判定，按未达标处理。
  for (const task of running.slice(MAX_TASKS)) {
    failures.push({ task, index: null, check: '', command: '', cwd: '', kind: 'budget' });
  }

  for (const task of running.slice(0, MAX_TASKS)) {
    const acceptance = Array.isArray(task?.acceptance) ? task.acceptance : [];
    if (acceptance.length === 0) {
      failures.push({ task, index: null, check: '', command: '', cwd: '', kind: 'no-acceptance' });
      continue;
    }
    for (let index = 0; index < acceptance.length; index++) {
      const entry = acceptance[index] ?? {};
      const check = typeof entry.check === 'string' ? entry.check : '';
      const verify = entry.verify;
      const command = typeof verify?.command === 'string' ? verify.command.trim() : '';
      const cwd = typeof verify?.cwd === 'string' ? verify.cwd.trim() : '';
      if (!command || !cwd) {
        failures.push({ task, index, check, command, cwd, kind: 'missing' });
        continue;
      }
      if (remaining() <= 0) {
        failures.push({ task, index, check, command, cwd, kind: 'budget' });
        continue;
      }
      const outcome = runVerify(command, cwd, Math.min(CMD_TIMEOUT_MS, remaining()));
      if (outcome.outcome === 'pass') continue;
      failures.push({ task, index, check, command, cwd, ...outcome });
    }
  }
  return failures;
}

function failureLine(failure) {
  const head = `- ${failure.task.id}「${failure.task.title ?? ''}」`;
  if (failure.kind === 'budget') return `${head}：未能判定（预算不足），先在回合内手动跑。`;
  if (failure.kind === 'no-acceptance') return `${head}：缺 acceptance（无 verify 可判），先补验收项。`;
  const entry = `第 ${failure.index + 1} 条${failure.check ? `「${failure.check}」` : ''}：`;
  if (failure.kind === 'missing') return `${head}${entry}缺 verify.command/cwd，无法判定。`;
  if (failure.outcome === 'timeout') {
    if (failure.timeoutMs >= CMD_TIMEOUT_MS) {
      return `${head}${entry}命令 \`${failure.command}\` 超时（${CMD_TIMEOUT_MS / 1000}s），未达标（cwd=${failure.cwd}）。`;
    }
    return `${head}${entry}命令 \`${failure.command}\` 超出判定预算（剩余 ${failure.timeoutMs}ms 内未完成），未能判定，先在回合内手动跑（cwd=${failure.cwd}）。`;
  }
  if (failure.outcome === 'spawn') {
    return `${head}${entry}命令 \`${failure.command}\` 无法执行（${failure.error}），未达标（cwd=${failure.cwd}）。`;
  }
  return `${head}${entry}命令 \`${failure.command}\` exit code ${failure.code}（cwd=${failure.cwd}），未达标。`;
}

const raw = await readStdin();
let payload = {};
try {
  payload = raw.trim() ? JSON.parse(raw) : {};
} catch {
  payload = {};
}

const sessionId = typeof payload.session_id === 'string' ? payload.session_id : '';
const board = readJson(MANIFEST);
const allRunning = Array.isArray(board?.tasks)
  ? board.tasks.filter((task) => task && task.status === 'running')
  : [];

// 没有进行中的任务：直接放行。
if (allRunning.length === 0 || !sessionId) {
  process.stdout.write('{}\n');
  process.exit(0);
}

// 只留自己名下的 running 任务；别人的不判。
const names = ownNames(sessionId);
const running = allRunning.filter((task) => ownsTask(task, sessionId, names));

if (running.length === 0) {
  process.stdout.write('{}\n');
  process.exit(0);
}

const now = Date.now();
const stateRaw = readJson(STATE);
const state = stateRaw && typeof stateRaw === 'object' ? stateRaw : {};
const previous = state[sessionId] ?? { blocks: 0, lastAt: 0 };
const withinCooldown = now - Number(previous.lastAt ?? 0) < COOLDOWN_MS;
const exhausted = Number(previous.blocks ?? 0) >= MAX_BLOCKS;

if (withinCooldown || exhausted) {
  process.stdout.write('{}\n');
  process.exit(0);
}

let failures;
try {
  failures = judgeDelivery(running);
} catch {
  failures = [];
  process.stdout.write('{}\n');
  process.exit(0);
}

if (failures.length === 0) {
  process.stdout.write('{}\n');
  process.exit(0);
}

state[sessionId] = { blocks: Number(previous.blocks ?? 0) + 1, lastAt: now };

for (const key of Object.keys(state)) {
  const at = Number(state[key]?.lastAt ?? 0);
  if (now - at > STATE_TTL_MS) delete state[key];
}
const keys = Object.keys(state);
if (keys.length > MAX_ENTRIES) {
  keys.sort((a, b) => Number(state[a]?.lastAt ?? 0) - Number(state[b]?.lastAt ?? 0));
  for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete state[key];
}

try {
  writeFileSync(STATE, JSON.stringify(state), 'utf8');
} catch {
  // 状态写不进去就不拦（fail-open）。
  process.stdout.write('{}\n');
  process.exit(0);
}

const reason = [
  `回合结束前自检：本会话名下 ${running.length} 个进行中任务，交付未达标 ${failures.length} 项：`,
  ...failures.map(failureLine),
  '先修上面点名的条目（同一条命令跑到 exit 0）再结束回合。',
].join('\n');

process.stdout.write(JSON.stringify({ decision: 'block', reason }) + '\n');
