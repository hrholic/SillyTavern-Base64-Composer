import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRequestTransport, decodeRequestTransport, normalizePipelineSettings } from '../pipeline.js';

const request = '<!-- Request: 保留请求 -->';
const database = '<data>{"姓名":"小明"}</data>';
const square = '[MVU]数据库内容[/MVU]';
const source = `正文🙂\n${request}\n${database}\n${square}\n结尾`;

for (const protectRequest of [false, true]) {
    for (const protectDatabase of [false, true]) {
        test(`independent protection request=${protectRequest}, database=${protectDatabase}`, () => {
            const output = buildRequestTransport(source, { protectRequest, protectDatabase });
            assert.equal(output.includes(request), protectRequest);
            assert.equal(output.includes(database), protectDatabase);
            assert.equal(output.includes(square), protectDatabase);
            assert.equal(output.includes('正文'), false);
            assert.equal(decodeRequestTransport(output), source);
        });
    }
}

test('legacy enabled protection migrates to both toggles and explicit choices win', () => {
    const migrated = normalizePipelineSettings({ protectSpecifiedCode: true });
    assert.equal(migrated.protectRequest, true);
    assert.equal(migrated.protectDatabase, true);
    const saved = JSON.parse(JSON.stringify({ ...migrated, protectRequest: false, protectDatabase: false }));
    const reloaded = normalizePipelineSettings(saved);
    assert.equal(reloaded.protectRequest, false);
    assert.equal(reloaded.protectDatabase, false);
    assert.equal(buildRequestTransport(source, reloaded).includes(request), false);
});

test('database-only protection finds nested data without preserving ordinary wrappers', () => {
    const original = `<plot>正文${database}后文</plot>`;
    const output = buildRequestTransport(original, { protectRequest: false, protectDatabase: true });
    assert.ok(output.includes(database));
    assert.ok(!output.includes('<plot>'));
    assert.equal(decodeRequestTransport(output), original);
});

test('request-only protection keeps code and directives but encodes data contents', () => {
    const original = '[SYSTEM_DIRECTIVE: 保留]\n```js\nconst x = 1;\n```\n' + database;
    const output = buildRequestTransport(original, { protectRequest: true, protectDatabase: false });
    assert.ok(output.includes('[SYSTEM_DIRECTIVE: 保留]'));
    assert.ok(output.includes('```js\nconst x = 1;\n```'));
    assert.ok(!output.includes('小明'));
    assert.equal(decodeRequestTransport(output), original);
});
