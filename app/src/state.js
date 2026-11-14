import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('state');

const RING = 1000;
const FLUSH_DEBOUNCE_MS = 400;

/**
 * 状态板：桥接器当前处于什么状态，落盘成 status.json，并对外提供只读快照。
 *
 * 状态取值：
 *   starting  进程刚起，还没连 OneBot
 *   standby   待机：没连上 OneBot（例如 QQ 还没登录），此时仍然可以反向注入测试
 *   idle      已连上 OneBot，随时可以接消息
 *   busy      正在跑 dsh
 *   stopping  收到退出信号
 *   suspended 熔断：连续出站失败/被踢等异常后主动停止出站（见 alert）
 *
