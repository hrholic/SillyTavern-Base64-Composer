import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);

test('manifest declares the supported frontend files and disables unpublished auto-update', async () => {
    const manifest = JSON.parse(await readFile(new URL('manifest.json', projectRoot), 'utf8'));
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.css, 'style.css');
    assert.equal(manifest.auto_update, false);
    assert.equal(manifest.display_name, 'base 64发送修改编码');
    assert.equal(typeof manifest.author, 'string');
});

test('UI keeps the requested 1px border and touch-safe drag behavior', async () => {
    const css = await readFile(new URL('style.css', projectRoot), 'utf8');
    assert.match(css, /border:\s*1px solid var\(--b64c-border\)/);
    assert.match(css, /touch-action:\s*none/);
    assert.match(css, /--b64c-bg:\s*rgba\([^;]+,\s*0\.5\)/);
    assert.match(css, /--b64c-action-bg:\s*rgba\([^;]+,\s*0\.2\)/);
    assert.match(css, /--b64c-action-bg-active:\s*rgba\([^;]+,\s*0\.5\)/);
    assert.match(css, /\.b64c-action\s*\{[^}]*border:\s*1px solid var\(--b64c-action-border\);[^}]*background:\s*var\(--b64c-action-bg\);/s);
    assert.match(css, /#chat \.b64c-message-badge\s*\{[^}]*border:\s*0;[^}]*background:\s*none;[^}]*box-shadow:\s*none;[^}]*opacity:\s*0\.58;/s);
    assert.match(css, /#chat \.b64c-message-badge\s*\{[^}]*margin:\s*3px 0 12px 12px;/s);
    assert.match(css, /\.b64c-message-snapshot\s*\{[^}]*max-width:\s*calc\(100% - 24px\);[^}]*max-height|\.b64c-snapshot-content\s*\{[^}]*max-height:/s);
    assert.match(css, /\[data-theme="light"\]/);
    assert.match(css, /\.b64c-send-enabled \.b64c-action\s*\{[^}]*border-color:\s*var\(--b64c-border-active\);[^}]*background:\s*var\(--b64c-action-bg-active\);/s);
    assert.doesNotMatch(css, /77d995|119,\s*217,\s*149/);
    assert.doesNotMatch(css, /b64c-request-active \.b64c-action::after/);
});

test('entrypoint keeps composer support and does not trigger send or generation calls', async () => {
    const source = await readFile(new URL('index.js', projectRoot), 'utf8');
    assert.match(source, /#send_textarea/);
    assert.doesNotMatch(source, /send_but|generateRaw|generateQuietPrompt/);
    assert.match(source, /textContent = '已编码'/);
    assert.doesNotMatch(source, /class="b64c-mode"|class="b64c-outgoing-mode"/);
    assert.doesNotMatch(source, /b64c-manual|b64c-undo|b64c-preserve/);
    assert.doesNotMatch(source, /b64c-send-status/);
    assert.match(source, /class="b64c-theme"/);
    assert.match(source, /class="b64c-protect-request"/);
    assert.match(source, /class="b64c-copy"/);
    assert.match(source, /<details class="b64c-pipeline-hint">/);
    assert.match(source, /<li>发送时编码：/);
    assert.match(source, /<li>响应正文提取：/);
    assert.match(source, /<span>指令改请求<\/span>/);
    assert.match(source, /<span>数据库指令保护<\/span>/);
    assert.match(source, /<li>指令改请求：/);
    assert.match(source, /<li>数据库指令保护：/);
    assert.match(source, /mode: 'structured'/);
    assert.match(source, /outgoingMode: 'chunked'/);
    assert.match(source, /protectRequest: requestInput\.checked/);
    assert.match(source, /theme: stored\.theme === 'light'/);
    assert.match(source, /badge\.addEventListener\('click'/);
    assert.match(source, /panel\.hidden = !panel\.hidden/);
    assert.match(source, /copyText\(snapshot\.payload\)/);
    assert.doesNotMatch(source, /context\.saveChat\?\.\(\)/);
});

test('response adaptation is restricted to the OpenAI-compatible chat completion endpoint', async () => {
    const source = await readFile(new URL('pipeline.js', projectRoot), 'utf8');
    assert.match(source, /\/api\/backends\/chat-completions\/generate/);
    assert.doesNotMatch(source, /text-completions\/generate|gateway|temperature|top_p|tool_choice/);
});

