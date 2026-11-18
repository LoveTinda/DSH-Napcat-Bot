import assert from 'node:assert/strict';
import { createGroupContext } from '../src/group-context.js';

/**
 * 群上下文纯函数：记录、容量、注入块排除当前这句。
 */
const gc = createGroupContext({ maxMessages: 3, maxChars: 300 });
gc.record({ groupId: '9', userId: '1', name: '甲', text: '第一句' });
gc.record({ groupId: '9', userId: '2', name: '乙', text: '第二句' });
gc.record({ groupId: '9', userId: '3', name: '丙', text: '当前这句' });
const block = gc.buildBlock('9');
assert.ok(block.includes('第一句'), block);
assert.ok(block.includes('第二句'), block);
assert.ok(!block.includes('当前这句'), block);
const st = gc.stats();
assert.equal(st.groups, 1);
assert.equal(st.messages, 3);
gc.clear('9');
assert.equal(gc.buildBlock('9'), '');
console.log('group-context: ok');
