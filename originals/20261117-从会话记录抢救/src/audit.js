import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('audit');

/**
 * 本地审计日志（JSONL，0600）。
 *
 * 只记录 operator/action/target/result/time；绝不记录 token、消息全文、私聊原文。
 * target 由调用方先脱敏（例如 maskChatKey）。
 */
export function createAuditLog(file) {
  return {
    file,
