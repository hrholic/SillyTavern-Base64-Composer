import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectRoot = new URL('../', import.meta.url);

test('manifest declares the supported frontend files and disables unpublished auto-update', async () => {
    const manifest = JSON.parse(await readFile(new URL('manifest.json', projectRoot), 'utf8'));
    assert.equal(manifest.js, 'index.js');
    assert.equal(manifest.css, 'style.css');
    assert.equal(manifest.auto_update, false);
    assert.equal(typeof manifest.display_name, 'string');
    assert.equal(typeof manifest.author, 'string');
});

test('UI keeps the requested 1px border and touch-safe drag behavior', async () => {
    const css = await readFile(new URL('style.css', projectRoot), 'utf8');
    assert.match(css, /border:\s*1px solid var\(--b64c-border\)/);
    assert.match(css, /touch-action:\s*none/);
});

test('entrypoint keeps composer support and does not trigger send or generation calls', async () => {
    const source = await readFile(new URL('index.js', projectRoot), 'utf8');
    assert.match(source, /#send_textarea/);
    assert.doesNotMatch(source, /send_but|generateRaw|generateQuietPrompt/);
    assert.match(source, /textContent = '已编码'/);
});

test('response adaptation is restricted to the OpenAI-compatible chat completion endpoint', async () => {
    const source = await readFile(new URL('pipeline.js', projectRoot), 'utf8');
    assert.match(source, /\/api\/backends\/chat-completions\/generate/);
    assert.doesNotMatch(source, /text-completions\/generate|gateway|temperature|top_p|tool_choice/);
});
