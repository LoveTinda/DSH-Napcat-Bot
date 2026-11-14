import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';
import { findSessionRef, validateSessionForResume, timeLabel } from './session-meta.js';
import { roleAtLeast } from './policy.js';
import { describeChat, SessionOwnershipError } from './session-manager.js';

const log = logger('command');

/**
