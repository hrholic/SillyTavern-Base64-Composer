import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';

import {
    buildScatterTransport,
    buildProtectedTransport,
    buildRequestTransport,
    createScopedFetchNormalizer,
    createTemporaryMessageAdapter,
    decodeScatterTransport,
    decodeProtectedTransport,
    decodeRequestTransport,
    inspectMessageTransportSnapshot,
    MESSAGE_TRANSPORT_APPLIED,
    MESSAGE_TRANSPORT_MARKER,
    MESSAGE_TRANSPORT_SNAPSHOT,
    normalizeChatCompletionResponse,
    normalizeCompletionObject,
} from '../pipeline.js';

const eventTypes = {
    GENERATION_STARTED: 'generation_started',
    GENERATE_AFTER_DATA: 'generate_after_data',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    CHAT_CHANGED: 'chat_changed',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
};

test('scatter transport preserves Unicode and every whitespace character exactly', () => {
    const original = '  中文🙂\n\r\n\t尾部  \n';
    const transport = buildScatterTransport(original, 3);
    assert.match(transport, /^1\/\d+:[A-Za-z0-9+/]+=*/);
    assert.doesNotMatch(transport, /\[B64\/1|\[\/B64\]/);
    assert.equal(decodeScatterTransport(transport), original);
});

test('scatter decoder keeps legacy wrapped snapshots readable', () => {
    const original = '旧记录🙂';
    const bare = buildScatterTransport(original, 3);
    const total = bare.split('\n').length;
    const legacy = `[B64/1 utf8; decode 1..${total}, join]\n${bare}\n[/B64]`;
    assert.equal(decodeScatterTransport(legacy), original);
});

test('request preview and preparation share whole/chunked transport behavior', () => {
    const original = '中文🙂abcdef';
    const whole = buildRequestTransport(original, { outgoingMode: 'whole', chunkSize: 2 });
    const chunked = buildRequestTransport(original, { outgoingMode: 'chunked', chunkSize: 2 });
    assert.equal(decodeScatterTransport(whole), original);
    assert.equal(decodeScatterTransport(chunked), original);
    assert.equal(whole.split('\n').filter((line) => /^\d+\/\d+:/.test(line)).length, 1);
    assert.ok(chunked.split('\n').filter((line) => /^\d+\/\d+:/.test(line)).length > 1);
});

test('protection keeps nested data blocks byte-for-byte and encodes surrounding prose', () => {
    const original = '开头🙂<recall id="r1"><recall>数据库原文</recall><JSONPatch>[{"op":"test"}]</JSONPatch></recall>结尾';
    const transport = buildProtectedTransport(original, 3);
    const preserved = '<recall id="r1"><recall>数据库原文</recall><JSONPatch>[{"op":"test"}]</JSONPatch></recall>';
    assert.match(transport, /^\[B64P\/1 utf8; decode \[\[B:i\/N:data\]\] in place\]/);
    assert.ok(transport.includes(preserved));
    assert.ok(!transport.includes('开头🙂'));
    assert.ok(!transport.includes('结尾'));
    assert.equal(decodeProtectedTransport(transport), original);
});

test('protection preserves tag order, comments and Request template tokens while encoding prose in place', () => {
    const original = [
        '你好',
        '<!-- Request: keep exactly -->',
        '<plot role="main">普通正文<em>强调</em></plot>',
        '<本轮用户输入>保留标签并编码正文</本轮用户输入>',
        '<Request: User轻触Character(s)的手>',
        '尾声',
    ].join('\n');
    const transport = buildRequestTransport(original, {
        outgoingMode: 'chunked',
        chunkSize: 4,
        protectSpecifiedCode: true,
    });
    assert.ok(transport.includes('<!-- Request: keep exactly -->'));
    assert.ok(transport.includes('<plot role="main">'));
    assert.ok(transport.includes('<em>'));
    assert.ok(transport.includes('</em></plot>'));
    assert.ok(transport.includes('<本轮用户输入>'));
    assert.ok(transport.includes('</本轮用户输入>'));
    assert.ok(!transport.includes('保留标签并编码正文'));
    assert.ok(transport.includes('<Request: User'));
    assert.ok(transport.includes('Character(s)'));
    assert.ok(!transport.includes('普通正文'));
    assert.ok(!transport.includes('轻触'));
    assert.ok(transport.indexOf('<plot role="main">') < transport.indexOf('</plot>'));
    assert.equal(decodeRequestTransport(transport), original);
});

test('protection preserves directives, code fences and conservative unclosed structures', () => {
    const original = [
        '前言🙂',
        '[SYSTEM_DIRECTIVE: {"items":[1, 2]}] keep this line',
        '```json',
        '{"machine":"原样"}',
        '```',
        '`inline 原样`',
        '<unknown attr="x">未闭合结构原样',
    ].join('\n');
    const transport = buildProtectedTransport(original, 2);
    assert.ok(transport.includes('[SYSTEM_DIRECTIVE: {"items":[1, 2]}] keep this line'));
    assert.ok(transport.includes('```json\n{"machine":"原样"}\n```'));
    assert.ok(transport.includes('`inline 原样`'));
    assert.ok(transport.includes('<unknown attr="x">未闭合结构原样'));
    assert.ok(!transport.includes('前言🙂'));
    assert.equal(decodeProtectedTransport(transport), original);
});

test('protected transport chooses a collision-free deterministic inline marker', () => {
    const original = '正文<recall>[[B:1/1:QQ==]]</recall>尾部';
    const transport = buildProtectedTransport(original, 2);
    assert.match(transport, /^\[B64P\/1 utf8; decode \[\[B_1:i\/N:data\]\] in place\]/);
    assert.ok(transport.includes('<recall>[[B:1/1:QQ==]]</recall>'));
    assert.equal(decodeProtectedTransport(transport), original);
});

test('compact transports keep whitespace-only protected gaps literal and avoid verbose metadata', () => {
    const original = '正文\n<!-- Request: -->\n<plot>后文</plot>';
    const scatter = buildRequestTransport(original, {
        outgoingMode: 'chunked',
        chunkSize: 8,
        protectSpecifiedCode: false,
    });
    const protectedText = buildRequestTransport(original, {
        outgoingMode: 'chunked',
        chunkSize: 8,
        protectSpecifiedCode: true,
    });
    assert.doesNotMatch(scatter, /encoding:|reconstruct:|BASE64-SCATTER/);
    assert.doesNotMatch(scatter, /\[B64\/1|\[\/B64\]/);
    assert.doesNotMatch(protectedText, /encoding:|reconstruct:|BASE64-PROTECTED|\[\[B:\d+\/\d+:Cg==\]\]/);
    assert.ok(protectedText.includes('<!-- Request: -->\n<plot>'));
    assert.equal(decodeRequestTransport(scatter), original);
    assert.equal(decodeRequestTransport(protectedText), original);
});

test('protection is opt-in and disabled output remains byte-identical to the old scatter transport', () => {
    const original = '正文<!-- Request: -->后文';
    const previous = buildScatterTransport(original, 3);
    const disabled = buildRequestTransport(original, {
        outgoingMode: 'chunked',
        chunkSize: 3,
        protectSpecifiedCode: false,
    });
    const enabled = buildRequestTransport(original, {
        outgoingMode: 'chunked',
        chunkSize: 3,
        protectSpecifiedCode: true,
    });
    assert.equal(disabled, previous);
    assert.notEqual(enabled, previous);
    assert.ok(enabled.includes('<!-- Request: -->'));
    assert.ok(!enabled.includes('后文'));
    assert.equal(decodeRequestTransport(enabled), original);
});

test('protected request uses the same adapter path, restores original and keeps applied metadata behavior', () => {
    const eventSource = new EventEmitter();
    const original = '你好\n<Request: User轻触Character(s)的手>';
    const message = { is_user: true, mes: original };
    const chat = [];
    let preview = '';
    const adapter = createTemporaryMessageAdapter({
        eventSource,
        eventTypes,
        getChat: () => chat,
        getSettings: () => ({ outgoingAdapterEnabled: true }),
        getTransportSettings: () => ({
            outgoingMode: 'chunked',
            chunkSize: 3,
            protectSpecifiedCode: true,
        }),
        onPreview: (value) => { preview = value; },
    });

    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    chat.push(message);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 0);
    assert.equal(message.mes, preview);
    assert.equal(decodeRequestTransport(preview), original);
    assert.equal(message.extra[MESSAGE_TRANSPORT_APPLIED], undefined);
    eventSource.emit(eventTypes.GENERATE_AFTER_DATA, {});
    assert.equal(message.mes, original);
    assert.equal(message.extra[MESSAGE_TRANSPORT_APPLIED], true);
    adapter.destroy();
});

test('request-ready stores the exact prepared fragment and later settings changes do not rewrite it', () => {
    const eventSource = new EventEmitter();
    const original = '快照正文🙂';
    const message = { is_user: true, mes: original };
    const chat = [];
    const settings = { outgoingMode: 'chunked', chunkSize: 2, protectSpecifiedCode: false };
    let prepared = '';
    let stored = null;
    const adapter = createTemporaryMessageAdapter({
        eventSource,
        eventTypes,
        getChat: () => chat,
        getSettings: () => ({ outgoingAdapterEnabled: true }),
        getTransportSettings: () => settings,
        getTimestamp: () => '2026-10-31T12:00:00.000Z',
        onPreview: (value) => { prepared = value; },
        onSnapshotStored: (records) => { stored = records; },
    });

    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    chat.push(message);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 0);
    eventSource.emit(eventTypes.GENERATE_AFTER_DATA, {});

    const snapshot = message.extra[MESSAGE_TRANSPORT_SNAPSHOT];
    assert.equal(snapshot.payload, prepared);
    assert.equal(snapshot.capturedAt, '2026-10-31T12:00:00.000Z');
    assert.equal(snapshot.swipeId, null);
    assert.equal(message.mes, original);
    assert.equal(stored[0].snapshot, snapshot);
    assert.equal(inspectMessageTransportSnapshot(message).status, 'current');

    settings.chunkSize = 100;
    settings.protectSpecifiedCode = true;
    assert.equal(message.extra[MESSAGE_TRANSPORT_SNAPSHOT].payload, prepared);
    adapter.destroy();
});

test('snapshot metadata stays isolated by message and swipe and never replaces message text', () => {
    const eventSource = new EventEmitter();
    const first = {
        is_user: true,
        mes: '第一条',
        swipe_id: 0,
        swipes: ['第一条'],
        swipe_info: [{ extra: {} }],
        extra: { [MESSAGE_TRANSPORT_MARKER]: true },
    };
    const second = {
        is_user: true,
        mes: '第二条',
        swipe_id: 1,
        swipes: ['旧滑页', '第二条'],
        swipe_info: [{ extra: {} }, { extra: {} }],
        extra: { [MESSAGE_TRANSPORT_MARKER]: true },
    };
    const adapter = createTemporaryMessageAdapter({
        eventSource,
        eventTypes,
        getChat: () => [first, second],
        getSettings: () => ({ outgoingAdapterEnabled: true }),
        getTransportSettings: () => ({ outgoingMode: 'chunked', chunkSize: 2 }),
        getTimestamp: () => '2026-10-31T13:00:00.000Z',
    });

    eventSource.emit(eventTypes.GENERATION_STARTED, 'regenerate', {}, false);
    const firstPrepared = first.mes;
    const secondPrepared = second.mes;
    eventSource.emit(eventTypes.GENERATE_AFTER_DATA, {});

    assert.equal(first.mes, '第一条');
    assert.equal(second.mes, '第二条');
    assert.equal(first.extra[MESSAGE_TRANSPORT_SNAPSHOT].payload, firstPrepared);
    assert.equal(second.extra[MESSAGE_TRANSPORT_SNAPSHOT].payload, secondPrepared);
    assert.equal(first.extra[MESSAGE_TRANSPORT_SNAPSHOT].swipeId, 0);
    assert.equal(second.extra[MESSAGE_TRANSPORT_SNAPSHOT].swipeId, 1);
    assert.equal(first.swipe_info[0].extra[MESSAGE_TRANSPORT_SNAPSHOT], first.extra[MESSAGE_TRANSPORT_SNAPSHOT]);
    assert.equal(second.swipe_info[1].extra[MESSAGE_TRANSPORT_SNAPSHOT], second.extra[MESSAGE_TRANSPORT_SNAPSHOT]);
    assert.equal(inspectMessageTransportSnapshot(first).status, 'current');
    assert.equal(inspectMessageTransportSnapshot(second).status, 'current');

    second.mes = '编辑后的第二条';
    assert.equal(inspectMessageTransportSnapshot(second).status, 'edited');
    second.swipe_id = 0;
    second.mes = '旧滑页';
    assert.equal(inspectMessageTransportSnapshot(second).status, 'missing');
    second.swipe_id = 1;
    second.mes = '第二条';
    assert.equal(inspectMessageTransportSnapshot(second).status, 'current');
    assert.equal(inspectMessageTransportSnapshot({ is_user: true, mes: '旧消息', extra: { [MESSAGE_TRANSPORT_APPLIED]: true } }).status, 'missing');
    assert.equal(JSON.parse(JSON.stringify(first)).mes, '第一条');
    adapter.destroy();
});

test('outgoing adapter waits for SillyTavern to render the new user message before swapping it', () => {
    const eventSource = new EventEmitter();
    const original = '  原文🙂\n第二行  ';
    const message = { is_user: true, mes: original, swipe_id: 0, swipes: [original] };
    const chat = [];
    let preview = '';
    const states = [];
    const adapter = createTemporaryMessageAdapter({
        eventSource,
        eventTypes,
        getChat: () => chat,
        getSettings: () => ({ outgoingAdapterEnabled: true }),
        getTransportSettings: () => ({ outgoingMode: 'chunked', chunkSize: 2 }),
        onPreview: (value) => { preview = value; },
        onStateChange: (value) => states.push(value),
    });

    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    assert.equal(message.extra, undefined);
    assert.equal(message.mes, original);
    chat.push(message);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 0);
    assert.equal(message.extra[MESSAGE_TRANSPORT_MARKER], true);
    assert.equal(message.extra[MESSAGE_TRANSPORT_APPLIED], undefined);
    assert.equal(message.mes, preview);
    assert.equal(message.swipes[0], preview);
    assert.equal(decodeScatterTransport(preview), original);

    eventSource.emit(eventTypes.GENERATE_AFTER_DATA, { prompt: 'already assembled' }, false);
    assert.equal(message.mes, original);
    assert.equal(message.swipes[0], original);
    assert.equal(message.extra[MESSAGE_TRANSPORT_APPLIED], true);
    assert.deepEqual(states.map((state) => state.active), [true, false]);
    adapter.destroy();
});

test('only the current enabled send and previously marked history are transported', () => {
    const eventSource = new EventEmitter();
    const oldUnmarked = { is_user: true, mes: 'old plain history' };
    const oldMarked = {
        is_user: true,
        mes: 'old opted-in history',
        extra: { [MESSAGE_TRANSPORT_MARKER]: true, [MESSAGE_TRANSPORT_APPLIED]: true },
    };
    const assistant = { is_user: false, mes: 'assistant reply' };
    const current = { is_user: true, mes: 'current send' };
    const chat = [oldUnmarked, oldMarked, assistant];
    const adapter = createTemporaryMessageAdapter({
        eventSource,
        eventTypes,
        getChat: () => chat,
        getSettings: () => ({ outgoingAdapterEnabled: true }),
        getTransportSettings: () => ({ outgoingMode: 'chunked', chunkSize: 4 }),
    });

    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    chat.push(current);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 3);
    assert.equal(oldUnmarked.mes, 'old plain history');
    assert.equal(assistant.mes, 'assistant reply');
    assert.equal(decodeScatterTransport(oldMarked.mes), 'old opted-in history');
    assert.equal(decodeScatterTransport(current.mes), 'current send');
    eventSource.emit(eventTypes.GENERATE_AFTER_DATA, {});
    assert.equal(oldMarked.mes, 'old opted-in history');
    assert.equal(current.mes, 'current send');

    eventSource.emit(eventTypes.GENERATION_STARTED, 'regenerate', {}, false);
    assert.equal(oldUnmarked.mes, 'old plain history');
    assert.equal(decodeScatterTransport(oldMarked.mes), 'old opted-in history');
    assert.equal(decodeScatterTransport(current.mes), 'current send');
    eventSource.emit(eventTypes.GENERATION_STOPPED);
    assert.equal(current.mes, 'current send');
    adapter.destroy();
});

test('outgoing adapter is inert while disabled and restores on stop without overwriting concurrent edits', () => {
    const eventSource = new EventEmitter();
    const message = { is_user: true, mes: 'original' };
    let enabled = false;
    const adapter = createTemporaryMessageAdapter({
        eventSource,
        eventTypes,
        getChat: () => [message],
        getSettings: () => ({ outgoingAdapterEnabled: enabled }),
    });

    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 0);
    assert.equal(message.mes, 'original');

    enabled = true;
    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 0);
    assert.notEqual(message.mes, 'original');
    message.mes = 'user changed this concurrently';
    eventSource.emit(eventTypes.GENERATION_STOPPED);
    assert.equal(message.mes, 'user changed this concurrently');
    adapter.destroy();
});

test('outgoing adapter ignores dry runs, non-normal generation and assistant messages', () => {
    const eventSource = new EventEmitter();
    const message = { is_user: true, mes: 'original' };
    const adapter = createTemporaryMessageAdapter({
        eventSource,
        eventTypes,
        getChat: () => [message],
        getSettings: () => ({ outgoingAdapterEnabled: true }),
    });

    eventSource.emit(eventTypes.GENERATION_STARTED, 'regenerate', {}, false);
    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, true);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 0);
    assert.equal(message.mes, 'original');
    message.is_user = false;
    eventSource.emit(eventTypes.GENERATION_STARTED, 'normal', {}, false);
    eventSource.emit(eventTypes.USER_MESSAGE_RENDERED, 0);
    assert.equal(message.mes, 'original');
    adapter.destroy();
});

test('JSON completion extracts a known body field while preserving tools and finish_reason', () => {
    const input = {
        id: 'x',
        choices: [{
            index: 0,
            finish_reason: 'tool_calls',
            message: {
                role: 'assistant',
                content: null,
                tool_calls: [{
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'deliver', arguments: JSON.stringify({ body: ' 正文🙂\n' }) },
                }],
            },
        }],
    };
    const result = normalizeCompletionObject(input);
    assert.equal(result.changed, true);
    assert.equal(result.value.choices[0].message.content, ' 正文🙂\n');
    assert.equal(result.value.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(result.value.choices[0].message.tool_calls, input.choices[0].message.tool_calls);
});

test('normal text, refusal text, errors and unknown argument structures are unchanged', () => {
    const values = [
        { choices: [{ message: { content: 'normal response' }, finish_reason: 'stop' }] },
        { choices: [{ message: { content: 'I cannot help with that.', refusal: 'policy' }, finish_reason: 'stop' }] },
        { error: { message: 'upstream failed' } },
        { choices: [{ message: { content: null, tool_calls: [{ function: { arguments: '{"other":"x"}' } }] } }] },
    ];
    for (const value of values) {
        const result = normalizeCompletionObject(value);
        assert.equal(result.changed, false);
        assert.equal(result.value, value);
    }
});

test('SSE tool arguments split across byte and event boundaries inject body once and retain usage/DONE', async () => {
    const events = [
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"bo"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"dy\\":\\"正文🙂\\"}"}}]},"finish_reason":null}]}\n\n',
        'data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n',
        'data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
        'data: [DONE]\n\n',
    ].join('');
    const bytes = new TextEncoder().encode(events);
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(bytes.slice(0, 37));
            controller.enqueue(bytes.slice(37, 113));
            controller.enqueue(bytes.slice(113));
            controller.close();
        },
    });
    const response = new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    const normalized = await normalizeChatCompletionResponse(response);
    const text = await normalized.text();

    const parsedEvents = text.split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)));
    const injectedContent = parsedEvents.flatMap((event) => event.choices ?? [])
        .map((choice) => choice.delta?.content)
        .filter((content) => content !== undefined);
    assert.deepEqual(injectedContent, ['正文🙂']);
    assert.match(text, /"finish_reason":"tool_calls"/);
    assert.match(text, /"usage":\{"prompt_tokens":1,"completion_tokens":2\}/);
    assert.match(text, /data: \[DONE\]/);
});

test('fetch normalizer installs only when enabled and scopes changes to the chat completion POST endpoint', async () => {
    const payload = {
        choices: [{
            message: { content: null, function_call: { arguments: '{"body":"visible"}' } },
            finish_reason: 'stop',
        }],
    };
    let calls = 0;
    const originalFetch = async () => {
        calls += 1;
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
    };
    const fakeWindow = { fetch: originalFetch, location: { href: 'https://localhost/' } };
    const controller = createScopedFetchNormalizer(fakeWindow);
    assert.equal(fakeWindow.fetch, originalFetch);

    controller.enable();
    const unrelated = await fakeWindow.fetch('/api/other', { method: 'POST' });
    assert.equal((await unrelated.json()).choices[0].message.content, null);
    const scoped = await fakeWindow.fetch('/api/backends/chat-completions/generate', { method: 'POST' });
    assert.equal((await scoped.json()).choices[0].message.content, 'visible');
    controller.disable();
    assert.equal(fakeWindow.fetch, originalFetch);
    assert.equal(calls, 2);
});
