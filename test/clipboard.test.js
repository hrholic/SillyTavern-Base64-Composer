import assert from 'node:assert/strict';
import test from 'node:test';

import { copyText } from '../clipboard.js';

test('preview copy reports Clipboard API success and copies the complete text', async () => {
    let copied = null;
    const result = await copyText('完整\n预览🙂', {
        navigatorObject: { clipboard: { writeText: async (value) => { copied = value; } } },
        documentObject: null,
    });
    assert.equal(result, true);
    assert.equal(copied, '完整\n预览🙂');
});

test('preview copy uses the mobile fallback and never reports a failed copy as success', async () => {
    const field = {
        style: {},
        value: '',
        setAttribute() {},
        focus() {},
        select() {},
        setSelectionRange() {},
        remove() { this.removed = true; },
    };
    const documentObject = {
        body: { append(value) { assert.equal(value, field); } },
        createElement() { return field; },
        execCommand() { return true; },
    };
    assert.equal(await copyText('fallback', {
        navigatorObject: { clipboard: { writeText: async () => { throw new Error('denied'); } } },
        documentObject,
    }), true);
    assert.equal(field.value, 'fallback');
    assert.equal(field.removed, true);

    documentObject.execCommand = () => false;
    assert.equal(await copyText('not copied', { navigatorObject: {}, documentObject }), false);
});
