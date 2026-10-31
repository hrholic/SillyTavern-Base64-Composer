import assert from 'node:assert/strict';
import test from 'node:test';

import {
    base64ToUtf8,
    clampPosition,
    createComposerController,
    createPointerInteraction,
    createTextareaTargetResolver,
    decodeConversionParts,
    decodeStructuredEnvelope,
    encodeText,
    utf8ToBase64,
} from '../core.js';

class FakeTextarea extends EventTarget {
    constructor(value = '') {
        super();
        this.value = value;
    }
}

function createTargetDocument(editors, composer) {
    return {
        activeElement: null,
        querySelectorAll(selector) {
            assert.equal(selector, 'textarea.edit_textarea');
            return editors;
        },
        querySelector(selector) {
            assert.equal(selector, '#send_textarea');
            return composer;
        },
    };
}

function createFakeTimer() {
    let nextId = 1;
    const callbacks = new Map();
    return {
        schedule(callback) {
            const id = nextId;
            nextId += 1;
            callbacks.set(id, callback);
            return id;
        },
        cancel(id) {
            callbacks.delete(id);
        },
        flush() {
            const pending = [...callbacks.values()];
            callbacks.clear();
            pending.forEach((callback) => callback());
        },
        get size() {
            return callbacks.size;
        },
    };
}

test('UTF-8 Base64 round-trips Chinese, emoji, spaces, and mixed newlines', () => {
    const original = '  中文🙂\nsecond line\r\n\t尾部空格  ';
    const encoded = utf8ToBase64(original);
    assert.equal(encoded, Buffer.from(original, 'utf8').toString('base64'));
    assert.equal(base64ToUtf8(encoded), original);
});

test('long content is encoded whole and restored exactly', () => {
    const original = '长文🙂 abc\n'.repeat(100_000);
    const encoded = utf8ToBase64(original);
    assert.equal(base64ToUtf8(encoded), original);
});

test('default settings preserve the original whole-Base64 behavior', () => {
    const original = '默认整段🙂';
    assert.equal(encodeText(original).output, Buffer.from(original).toString('base64'));
});

test('chunk mode splits by Unicode code point and every numbered chunk is standard Base64', () => {
    const original = '你🙂好abc';
    const conversion = encodeText(original, { mode: 'chunked', chunkSize: 2 });
    const lines = conversion.output.split('\n');
    assert.deepEqual(lines.map((line) => line.slice(0, line.indexOf(':'))), ['1/3', '2/3', '3/3']);
    assert.deepEqual(
        lines.map((line) => base64ToUtf8(line.slice(line.indexOf(':') + 1))),
        ['你🙂', '好a', 'bc'],
    );
    assert.equal(decodeConversionParts(conversion.parts), original);
});

test('technical preservation is conservative and round-trips exact original text', () => {
    const original = '正文 `x()` [文档](https://example.com/a) <span>尾部</span>\n```js\nconst x = 1;\n```';
    const conversion = encodeText(original, { mode: 'chunked', chunkSize: 3, preserveTechnical: true });
    assert.match(conversion.output, /`x\(\)`/);
    assert.match(conversion.output, /\[文档\]\(https:\/\/example\.com\/a\)/);
    assert.match(conversion.output, /<span>/);
    assert.match(conversion.output, /```js\nconst x = 1;\n```/);
    assert.equal(decodeConversionParts(conversion.parts), original);
});

test('structured mode emits a transparent ordered JSON envelope and restores exact Unicode text', () => {
    const original = '你🙂好abc\n第二行';
    const conversion = encodeText(original, { mode: 'structured', chunkSize: 2 });
    const envelope = JSON.parse(conversion.output);
    assert.equal(envelope.format, 'sillytavern-base64-envelope');
    assert.equal(envelope.version, 1);
    assert.equal(envelope.encoding, 'utf-8/base64');
    assert.deepEqual(envelope.chunks.map((chunk) => chunk.index), [1, 2, 3, 4, 5]);
    assert.equal(decodeStructuredEnvelope(conversion.output), original);
});

test('structured mode visibly encodes the full text and does not apply technical preservation', () => {
    const original = '`code` [link](https://example.com) <b>text</b>';
    const conversion = encodeText(original, {
        mode: 'structured',
        chunkSize: 8,
        preserveTechnical: true,
    });
    assert.doesNotMatch(conversion.output, /`code`|\[link\]|<b>/);
    assert.equal(decodeStructuredEnvelope(conversion.output), original);
});

test('empty input does nothing and emits no input event', () => {
    const textarea = new FakeTextarea('');
    let inputEvents = 0;
    textarea.addEventListener('input', () => { inputEvents += 1; });
    const controller = createComposerController(textarea);

    assert.deepEqual(controller.encode(), { ok: false, code: 'empty' });
    assert.equal(textarea.value, '');
    assert.equal(inputEvents, 0);
});

test('encoding replaces only the textarea and emits one bubbling input event', () => {
    const original = '原文 with emoji 🐈\n保留换行';
    const textarea = new FakeTextarea(original);
    let inputEvents = 0;
    textarea.addEventListener('input', () => { inputEvents += 1; });
    const controller = createComposerController(textarea);

    const result = controller.encode();
    assert.equal(result.ok, true);
    assert.equal(textarea.value, Buffer.from(original).toString('base64'));
    assert.equal(inputEvents, 1);
    assert.equal(controller.canUndo(), true);
});

test('a consecutive accidental click does not Base64-encode the Base64 again', () => {
    const textarea = new FakeTextarea('只转换一次');
    let inputEvents = 0;
    textarea.addEventListener('input', () => { inputEvents += 1; });
    const controller = createComposerController(textarea);

    const first = controller.encode();
    const encodedOnce = textarea.value;
    const second = controller.encode();

    assert.equal(first.ok, true);
    assert.deepEqual(second, { ok: false, code: 'already_encoded' });
    assert.equal(textarea.value, encodedOnce);
    assert.equal(inputEvents, 1);
});

test('undo restores exact original text', () => {
    const original = '  保留空格\n🙂  ';
    const textarea = new FakeTextarea(original);
    const controller = createComposerController(textarea);
    textarea.addEventListener('input', () => controller.handleInput());

    controller.encode();
    assert.equal(controller.undo().code, 'undone');
    assert.equal(textarea.value, original);
    assert.equal(controller.canUndo(), false);
});

test('typing after conversion invalidates undo so it cannot overwrite new text', () => {
    const textarea = new FakeTextarea('原文');
    const controller = createComposerController(textarea);
    textarea.addEventListener('input', () => controller.handleInput());

    controller.encode();
    textarea.value += '用户新写内容';
    textarea.dispatchEvent(new Event('input'));

    assert.equal(controller.canUndo(), false);
    assert.deepEqual(controller.undo(), { ok: false, code: 'nothing_to_undo' });
    assert.match(textarea.value, /用户新写内容$/);
});

test('visible message editor is preferred over the bottom composer', () => {
    const composer = new FakeTextarea('底部草稿');
    const editor = new FakeTextarea('消息编辑草稿');
    const documentObject = createTargetDocument([editor], composer);
    const resolver = createTextareaTargetResolver(documentObject, { isVisible: () => true });
    const controller = createComposerController(resolver.resolve, () => {});

    controller.encode();
    assert.equal(editor.value, Buffer.from('消息编辑草稿').toString('base64'));
    assert.equal(composer.value, '底部草稿');
});

test('most recently focused visible message editor wins after the floating button takes focus', () => {
    const composer = new FakeTextarea('底部');
    const first = new FakeTextarea('第一条');
    const second = new FakeTextarea('第二条');
    const documentObject = createTargetDocument([first, second], composer);
    const resolver = createTextareaTargetResolver(documentObject, { isVisible: () => true });

    resolver.recordFocus(first);
    resolver.recordFocus(second);
    documentObject.activeElement = { tagName: 'BUTTON' };
    assert.equal(resolver.resolve(), second);
});

test('bottom composer remains the fallback when no message editor is visible', () => {
    const composer = new FakeTextarea('底部草稿');
    const hiddenEditor = new FakeTextarea('隐藏编辑');
    const documentObject = createTargetDocument([hiddenEditor], composer);
    const resolver = createTextareaTargetResolver(documentObject, { isVisible: () => false });
    assert.equal(resolver.resolve(), composer);
});

test('undo stays bound to its original editor and never overwrites a different current target', () => {
    const first = new FakeTextarea('第一条');
    const second = new FakeTextarea('第二条');
    let current = first;
    const controller = createComposerController(() => current, () => {});

    controller.encode();
    current = second;
    assert.equal(controller.undo().code, 'undone');
    assert.equal(first.value, '第一条');
    assert.equal(second.value, '第二条');
});

test('undo does not fall through to composer after the original editor is removed', () => {
    const editor = new FakeTextarea('编辑草稿');
    editor.isConnected = true;
    const composer = new FakeTextarea('底部草稿');
    let current = editor;
    const controller = createComposerController(() => current, () => {});

    controller.encode();
    editor.isConnected = false;
    current = composer;
    assert.equal(controller.undo().code, 'target_unavailable');
    assert.equal(composer.value, '底部草稿');
});

test('short mouse tap immediately invokes only the default conversion action', () => {
    const timer = createFakeTimer();
    let taps = 0;
    let longPresses = 0;
    const pointer = createPointerInteraction({
        onTap: () => { taps += 1; },
        onLongPress: () => { longPresses += 1; },
        schedule: timer.schedule,
        cancelSchedule: timer.cancel,
    });

    pointer.pointerDown({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 20, clientY: 20 });
    assert.equal(pointer.pointerUp({ pointerId: 1, pointerType: 'mouse' }), 'tap');
    assert.equal(taps, 1);
    timer.flush();
    assert.equal(taps, 1);
    assert.equal(longPresses, 0);
});

test('500ms simulated touch hold opens options and release never taps', () => {
    const timer = createFakeTimer();
    let taps = 0;
    let longPresses = 0;
    const pointer = createPointerInteraction({
        onTap: () => { taps += 1; },
        onLongPress: () => { longPresses += 1; },
        schedule: timer.schedule,
        cancelSchedule: timer.cancel,
    });

    pointer.pointerDown({ pointerId: 4, pointerType: 'touch', clientX: 20, clientY: 20 });
    timer.flush();
    assert.equal(longPresses, 1);
    assert.equal(pointer.pointerUp({ pointerId: 4, pointerType: 'touch' }), 'long-press');

    assert.equal(taps, 0);
    assert.equal(longPresses, 1);
});

test('simulated touch drag cancels tap and long press', () => {
    const timer = createFakeTimer();
    let taps = 0;
    let longPresses = 0;
    let dragStarts = 0;
    let drags = 0;
    let dragEnds = 0;
    const pointer = createPointerInteraction({
        onTap: () => { taps += 1; },
        onLongPress: () => { longPresses += 1; },
        onDragStart: () => { dragStarts += 1; },
        onDrag: () => { drags += 1; },
        onDragEnd: () => { dragEnds += 1; },
        schedule: timer.schedule,
        cancelSchedule: timer.cancel,
    });

    pointer.pointerDown({ pointerId: 7, pointerType: 'touch', clientX: 5, clientY: 5 });
    pointer.pointerMove({ pointerId: 7, pointerType: 'touch', clientX: 40, clientY: 30 });
    assert.equal(pointer.pointerUp({ pointerId: 7, pointerType: 'touch' }), 'drag');
    timer.flush();

    assert.equal(taps, 0);
    assert.equal(longPresses, 0);
    assert.equal(dragStarts, 1);
    assert.equal(drags, 1);
    assert.equal(dragEnds, 1);
});

test('movement exactly below the threshold remains a tap', () => {
    const timer = createFakeTimer();
    let taps = 0;
    let dragStarts = 0;
    const pointer = createPointerInteraction({
        onTap: () => { taps += 1; },
        onLongPress: () => {},
        onDragStart: () => { dragStarts += 1; },
        schedule: timer.schedule,
        cancelSchedule: timer.cancel,
    });

    pointer.pointerDown({ pointerId: 2, pointerType: 'touch', clientX: 0, clientY: 0 });
    pointer.pointerMove({ pointerId: 2, pointerType: 'touch', clientX: 3, clientY: 4 });
    pointer.pointerUp({ pointerId: 2, pointerType: 'touch' });

    assert.equal(taps, 1);
    assert.equal(dragStarts, 0);
});

test('position clamping keeps the control inside a shifted mobile visual viewport', () => {
    const viewport = { left: 3, top: 120, width: 360, height: 500 };
    const size = { width: 48, height: 34 };
    assert.deepEqual(
        clampPosition({ x: -100, y: 900 }, size, viewport, 8),
        { x: 11, y: 578 },
    );
});
