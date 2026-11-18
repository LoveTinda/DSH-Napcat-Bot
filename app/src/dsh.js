/**
 * 目的：以 headless 子进程运行 DSH，解析 NDJSON 事件。
 * 边界：不重试、不排队；超时由调用方控制。
 * 依赖：node:child_process；被 bridge.js 调用。
 * 失败：spawn/退出码错误抛给调用方。
 */
import { spawn } from 'node:child_process';
import { logger } from './log.js';

const log = logger('dsh');

/**
 * 杀掉 dsh 的整个进程组，而不只是直接子进程。
 *
 * dsh 可能再拉工具/子 agent；只 kill 直接子进程会留下孙进程继续占会话/锁。
 * detached:true 让子进程成为新进程组组长，超时/中断时用 -pid 一次带走整组。
 * 失败就退回 child.kill，绝不因为清理失败而阻止上层收尾。
 */
export function killChildTree(child, signal = 'SIGKILL') {
  if (!child || !child.pid) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    try { child.kill(signal); return true; } catch { return false; }
  }
}

/**
 * Run one dsh headless task and fold its --json event stream into one result.
 *
 * The task is written to stdin rather than passed as a positional argument so a
 * chat message that starts with "-" can never be parsed as a CLI option, and so
 * no shell/argv escaping is involved.
 *
 * Contract (from @deepseek-ai/dsh-headless README):
 *   - the stream opens with a `session` event carrying the session id
 *   - it closes with `final` carrying the lossless answer
 *   - exit code 0 means completed, 1 means aborted/errored
 *   - a `--session-id` that does not exist fails before the task runs
 */
export function runDsh(opts) {
  const {
    command = 'dsh',
    profile = 'headless',
    cwd,
    sessionId,
    task,
    timeoutMs = 900000,
    extraArgs = [],
    onEvent = () => {},
    onSpawn = () => {}
  } = opts;

  // 顺序有讲究：`dsh` 启动器**只解析自己的旗标**，遇到第一个不认识的 token 就把
  // 后面所有参数原样交给 app（headless）。所以 `--profile/--patch/--session-id(启动器无此项)`
  // 这些必须排在 app 旗标 `--json` 之前，否则 `--patch` 会被 app 当成未知选项拒掉：
  //   dsh --profile qq --json --patch x.yml   → {"type":"error","message":"unknown option '--patch'"}
  //   dsh --profile qq --patch x.yml --json   → 正常跑
  const args = ['--profile', profile];
  if (extraArgs.length) args.push(...extraArgs);
  args.push('--json');
  if (sessionId) args.push('--session-id', sessionId);

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        // POSIX 下单独成组，便于超时/中断时清理孙进程（Termux/proot 同样是 POSIX）。
        detached: process.platform !== 'win32'
      });
    } catch (err) {
      reject(err);
      return;
    }

    try { onSpawn(child); } catch (err) { log.debug('onSpawn 抛错: ' + err.message); }

    const state = {
      sessionId: sessionId ?? null,
      text: undefined,
      reason: null,
      error: null,
      events: 0,
      stderrTail: []
    };

    let settled = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';

    const timer = setTimeout(() => {
      if (settled) return;
      log.warn('任务超时 ' + timeoutMs + 'ms，终止 dsh 进程组');
      killChildTree(child, 'SIGKILL');
      settle(new Error('任务超时（' + Math.round(timeoutMs / 1000) + ' 秒）'));
    }, timeoutMs);

    const settle = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve(value);
    };

    const handleEvent = (ev) => {
      state.events++;
      if (ev.type === 'session' && ev.sessionId) state.sessionId = ev.sessionId;
      else if (ev.type === 'final') state.text = ev.text;
      else if (ev.type === 'error') state.error = ev.message;
      else if (ev.type === 'status' && ev.phase === 'turn_end') state.reason = ev.reason;
      try { onEvent(ev); } catch (err) { log.debug('onEvent 抛错: ' + err.message); }
    };

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      for (;;) {
        const nl = stdoutBuffer.indexOf('\n');
        if (nl === -1) break;
        const line = stdoutBuffer.slice(0, nl).trim();
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (!line) continue;
        try { handleEvent(JSON.parse(line)); }
        catch { log.debug('跳过非 JSON 行: ' + line.slice(0, 200)); }
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk;
      for (;;) {
        const nl = stderrBuffer.indexOf('\n');
        if (nl === -1) break;
        const line = stderrBuffer.slice(0, nl);
        stderrBuffer = stderrBuffer.slice(nl + 1);
        if (!line.trim()) continue;
        state.stderrTail.push(line);
        if (state.stderrTail.length > 40) state.stderrTail.shift();
        log.debug('stderr: ' + line.slice(0, 300));
      }
    });

    child.on('error', (err) => {
      settle(new Error('无法启动 dsh（' + command + '）: ' + err.message));
    });

    child.on('close', (code, signal) => {
      const tail = state.stderrTail.join('\n');
      if (state.error) {
        settle(new Error('dsh 报错: ' + state.error));
        return;
      }
      if (code !== 0) {
        const detail = tail ? ': ' + tail.split('\n').slice(-3).join(' | ') : '';
        settle(new Error('dsh 退出码 ' + code + (signal ? ' (signal ' + signal + ')' : '') + detail));
        return;
      }
      if (state.text === undefined) {
        settle(new Error('dsh 未产出 final 事件' + (tail ? ': ' + tail.split('\n').slice(-3).join(' | ') : '')));
        return;
      }
      settle(null, state);
    });

    child.stdin.on('error', (err) => {
      if (err.code !== 'EPIPE') log.debug('stdin 错误: ' + err.message);
    });
    try {
      child.stdin.write(task, 'utf8');
      child.stdin.end();
    } catch (err) {
      log.debug('写入 stdin 失败: ' + err.message);
    }
  });
}
