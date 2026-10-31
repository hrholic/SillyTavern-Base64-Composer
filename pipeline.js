import { base64ToUtf8, utf8ToBase64 } from './core.js';
import { splitProtectedSegments } from './protection.js';

export const CHAT_COMPLETION_ENDPOINT = '/api/backends/chat-completions/generate';
export const MESSAGE_TRANSPORT_MARKER = 'base64_composer_transport_v1';
export const MESSAGE_TRANSPORT_APPLIED = 'base64_composer_transport_applied_v1';
export const MESSAGE_TRANSPORT_SNAPSHOT = 'base64_composer_transport_snapshot_v1';

export const DEFAULT_PIPELINE_SETTINGS = Object.freeze({
    outgoingAdapterEnabled: false,
    responseNormalizerEnabled: false,
    outgoingMode: 'chunked',
    protectSpecifiedCode: false,
});

export function normalizePipelineSettings(settings = {}) {
    return {
        outgoingAdapterEnabled: settings.outgoingAdapterEnabled === true,
        responseNormalizerEnabled: settings.responseNormalizerEnabled === true,
        outgoingMode: settings.outgoingMode === 'whole' ? 'whole' : 'chunked',
        protectSpecifiedCode: settings.protectSpecifiedCode === true,
    };
}

/**
 * A visible, reversible transport used only while SillyTavern assembles a
 * normal outgoing request. Chunks are ordered and independently decodable.
 */
export function buildScatterTransport(text, requestedChunkSize = 8) {
    const parsedSize = Number.parseInt(requestedChunkSize, 10);
    const chunkSize = Number.isFinite(parsedSize) ? Math.min(1000, Math.max(1, parsedSize)) : 8;
    const codePoints = Array.from(text);
    const chunks = [];

    for (let offset = 0; offset < codePoints.length; offset += chunkSize) {
        chunks.push(utf8ToBase64(codePoints.slice(offset, offset + chunkSize).join('')));
    }

    const lines = chunks.map((data, offset) => `${offset + 1}/${chunks.length}:${data}`);
    return [
        `[B64/1 utf8; decode 1..${chunks.length}, join]`,
        ...lines,
        '[/B64]',
    ].join('\n');
}

export function decodeScatterTransport(transport) {
    const lines = transport.split('\n');
    const headerMatch = lines[0]?.match(/^\[B64\/1 utf8; decode 1\.\.(\d+), join\]$/);
    if (!headerMatch || lines.at(-1) !== '[/B64]') {
        throw new Error('Invalid Base64 scatter transport.');
    }

    const chunkLines = lines.slice(1, -1);
    if (Number(headerMatch[1]) !== chunkLines.length) {
        throw new Error('Incomplete Base64 scatter transport.');
    }
    return chunkLines.map((line, offset) => {
        const match = line.match(/^(\d+)\/(\d+):([A-Za-z0-9+/]*={0,2})$/);
        if (!match
            || Number(match[1]) !== offset + 1
            || Number(match[2]) !== chunkLines.length) {
            throw new Error('Invalid or unordered Base64 scatter chunk.');
        }
        return base64ToUtf8(match[3]);
    }).join('');
}

const PROTECTED_MAGIC = '[B64P/1 utf8; decode [[';
const PROTECTED_SUFFIX = '\n[/B64P]';

function createProtectedPrefix(marker) {
    return `[B64P/1 utf8; decode [[${marker}:i/N:data]] in place]\n`;
}

export function decodeProtectedTransport(transport) {
    if (!transport.startsWith(PROTECTED_MAGIC) || !transport.endsWith(PROTECTED_SUFFIX)) {
        throw new Error('Invalid protected Base64 transport.');
    }
    const firstLineEnd = transport.indexOf('\n');
    const header = firstLineEnd < 0 ? '' : transport.slice(0, firstLineEnd);
    const markerMatch = header.match(/^\[B64P\/1 utf8; decode \[\[([A-Z0-9_]+):i\/N:data\]\] in place\]$/);
    if (!markerMatch) {
        throw new Error('Invalid protected Base64 marker.');
    }
    const content = transport.slice(firstLineEnd + 1, -PROTECTED_SUFFIX.length);
    const marker = markerMatch[1];
    const tokenPattern = new RegExp(`\\[\\[${marker}:(\\d+)\\/(\\d+):([A-Za-z0-9+/]*={0,2})\\]\\]`, 'g');
    let expectedIndex = 1;
    let expectedTotal = null;
    const decoded = content.replace(tokenPattern, (_token, indexText, totalText, data) => {
        const index = Number(indexText);
        const total = Number(totalText);
        if (expectedTotal === null) {
            expectedTotal = total;
        }
        if (index !== expectedIndex || total !== expectedTotal) {
            throw new Error('Invalid or unordered protected Base64 segment.');
        }
        expectedIndex += 1;
        return base64ToUtf8(data);
    });
    if (expectedTotal === null || expectedIndex - 1 !== expectedTotal) {
        throw new Error('Incomplete protected Base64 transport.');
    }
    return decoded;
}

export function buildProtectedTransport(text, requestedChunkSize = 8) {
    const parsedSize = Number.parseInt(requestedChunkSize, 10);
    const chunkSize = Number.isFinite(parsedSize) ? Math.min(1000, Math.max(1, parsedSize)) : 8;
    const segments = splitProtectedSegments(text);
    const parts = [];

    for (const segment of segments) {
        if (segment.kind === 'preserved') {
            parts.push(segment);
            continue;
        }
        if (/^\s+$/.test(segment.text)) {
            parts.push({ kind: 'preserved', text: segment.text });
            continue;
        }
        const codePoints = Array.from(segment.text);
        for (let offset = 0; offset < codePoints.length; offset += chunkSize) {
            const source = codePoints.slice(offset, offset + chunkSize).join('');
            parts.push({ kind: 'encoded', data: utf8ToBase64(source) });
        }
    }

    const encodedParts = parts.filter((part) => part.kind === 'encoded');
    if (encodedParts.length === 0) {
        return text;
    }
    let marker = 'B';
    let markerOffset = 1;
    while (text.includes(`[[${marker}:`)) {
        marker = `B_${markerOffset}`;
        markerOffset += 1;
    }
    let index = 0;
    const content = parts.map((part) => {
        if (part.kind === 'preserved') {
            return part.text;
        }
        index += 1;
        return `[[${marker}:${index}/${encodedParts.length}:${part.data}]]`;
    }).join('');
    const output = `${createProtectedPrefix(marker)}${content}${PROTECTED_SUFFIX}`;
    if (decodeProtectedTransport(output) !== text) {
        throw new Error('Protected Base64 round-trip failed.');
    }
    return output;
}

export function decodeRequestTransport(transport) {
    return transport.startsWith(PROTECTED_MAGIC)
        ? decodeProtectedTransport(transport)
        : decodeScatterTransport(transport);
}

/** The single conversion entry used by both preview and request preparation. */
export function buildRequestTransport(text, settings = {}) {
    if (settings.protectSpecifiedCode === true) {
        return buildProtectedTransport(text, settings.chunkSize);
    }
    const mode = settings.outgoingMode === 'whole' ? 'whole' : 'chunked';
    const chunkSize = mode === 'whole' ? Math.max(1, Array.from(text).length) : settings.chunkSize;
    return buildScatterTransport(text, chunkSize);
}

export function inspectMessageTransportSnapshot(message) {
    const currentSwipeId = Number.isInteger(message?.swipe_id) ? message.swipe_id : null;
    const currentSwipeExtra = currentSwipeId !== null
        && message?.swipe_info?.[currentSwipeId]?.extra
        && typeof message.swipe_info[currentSwipeId].extra === 'object'
        ? message.swipe_info[currentSwipeId].extra
        : null;
    const snapshot = (currentSwipeExtra ?? message?.extra)?.[MESSAGE_TRANSPORT_SNAPSHOT];
    if (!snapshot
        || snapshot.version !== 1
        || typeof snapshot.payload !== 'string'
        || typeof snapshot.capturedAt !== 'string'
        || !(snapshot.swipeId === null || Number.isInteger(snapshot.swipeId))) {
        return { status: 'missing', snapshot: null };
    }

    let decoded;
    try {
        decoded = decodeRequestTransport(snapshot.payload);
    } catch {
        return { status: 'invalid', snapshot };
    }

    if (snapshot.swipeId !== currentSwipeId) {
        return { status: 'different_swipe', snapshot };
    }
    if (decoded !== message?.mes) {
        return { status: 'edited', snapshot };
    }
    return { status: 'current', snapshot };
}

/**
 * A normal send made while enabled marks only that new user message. Marked
 * messages keep their transport choice when they re-enter later prompts, while
 * old/unmarked history stays untouched. Text is always restored after assembly.
 */
export function createTemporaryMessageAdapter({
    eventSource,
    eventTypes,
    getChat,
    getSettings,
    getTransportSettings = () => ({ outgoingMode: 'chunked', chunkSize: 8 }),
    onPreview = () => {},
    onStateChange = () => {},
    onSnapshotStored = () => {},
    getTimestamp = () => new Date().toISOString(),
}) {
    let active = null;
    let pendingNormalSend = false;
    const supportedGenerationTypes = new Set(['normal', 'regenerate', 'swipe', 'continue']);

    function restore(reason = 'restore') {
        const hadPendingSend = pendingNormalSend;
        pendingNormalSend = false;
        if (!active) {
            return hadPendingSend;
        }

        const records = active.records;
        active = null;

        const capturedAt = reason === 'request-ready' ? getTimestamp() : null;
        const storedSnapshots = [];
        for (const record of records) {
            if (record.message.mes === record.prepared) {
                record.message.mes = record.original;
            }
            if (record.swipeChanged
                && record.message.swipes?.[record.swipeId] === record.prepared) {
                record.message.swipes[record.swipeId] = record.originalSwipe;
            }
            if (reason === 'request-ready') {
                record.message.extra = record.message.extra && typeof record.message.extra === 'object'
                    ? record.message.extra
                    : {};
                record.message.extra[MESSAGE_TRANSPORT_APPLIED] = true;
                const snapshot = {
                    version: 1,
                    payload: record.prepared,
                    capturedAt,
                    swipeId: record.swipeId >= 0 ? record.swipeId : null,
                };
                record.message.extra[MESSAGE_TRANSPORT_SNAPSHOT] = snapshot;
                const swipeInfo = record.swipeId >= 0
                    ? record.message.swipe_info?.[record.swipeId]
                    : null;
                if (swipeInfo && typeof swipeInfo === 'object') {
                    swipeInfo.extra = swipeInfo.extra && typeof swipeInfo.extra === 'object'
                        ? swipeInfo.extra
                        : {};
                    swipeInfo.extra[MESSAGE_TRANSPORT_APPLIED] = true;
                    swipeInfo.extra[MESSAGE_TRANSPORT_SNAPSHOT] = snapshot;
                }
                storedSnapshots.push({ message: record.message, snapshot });
            }
        }

        if (storedSnapshots.length > 0) {
            onSnapshotStored(storedSnapshots);
        }
        onStateChange({ active: false, reason, count: records.length });
        return true;
    }

    function prepareMarkedMessages() {
        const chat = getChat();
        if (!Array.isArray(chat)) {
            return false;
        }

        const records = [];
        for (const message of chat) {
            if (!message?.is_user
                || message.extra?.[MESSAGE_TRANSPORT_MARKER] !== true
                || typeof message.mes !== 'string'
                || message.mes.length === 0) {
                continue;
            }

            const original = message.mes;
            const prepared = buildRequestTransport(original, getTransportSettings());
            if (prepared === original) {
                continue;
            }
            if (decodeRequestTransport(prepared) !== original) {
                return false;
            }

            const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : -1;
            const originalSwipe = swipeId >= 0 ? message.swipes?.[swipeId] : undefined;
            const swipeChanged = typeof originalSwipe === 'string' && originalSwipe === original;
            records.push({ message, original, prepared, swipeId, originalSwipe, swipeChanged });
        }

        if (records.length === 0) {
            return false;
        }

        active = { records };
        for (const record of records) {
            record.message.mes = record.prepared;
            if (record.swipeChanged) {
                record.message.swipes[record.swipeId] = record.prepared;
            }
        }

        onPreview(records.at(-1).prepared);
        onStateChange({ active: true, reason: 'prepare', count: records.length });
        return true;
    }

    function onGenerationStarted(type, options = {}, dryRun = false) {
        pendingNormalSend = false;
        if (dryRun
            || !supportedGenerationTypes.has(type)
            || options?.quiet_prompt
            || !getSettings().outgoingAdapterEnabled
            || active) {
            return false;
        }

        // SillyTavern emits GENERATION_STARTED before it reads #send_textarea
        // and before sendMessageAsUser adds the current message to chat.
        if (type === 'normal' && !options?.automatic_trigger) {
            pendingNormalSend = true;
            return true;
        }

        return prepareMarkedMessages();
    }

    function onUserMessageRendered(messageId) {
        if (!pendingNormalSend || !getSettings().outgoingAdapterEnabled || active) {
            return false;
        }
        pendingNormalSend = false;

        const chat = getChat();
        const message = Array.isArray(chat) && Number.isInteger(messageId) ? chat[messageId] : null;
        if (!message?.is_user || typeof message.mes !== 'string') {
            return false;
        }

        message.extra = message.extra && typeof message.extra === 'object' ? message.extra : {};
        message.extra[MESSAGE_TRANSPORT_MARKER] = true;
        return prepareMarkedMessages();
    }

    const bindings = [
        [eventTypes.GENERATION_STARTED, onGenerationStarted],
        // USER_MESSAGE_RENDERED occurs after addOneMessage used the original
        // text, but before sendMessageAsUser returns and coreChat is cloned.
        [eventTypes.USER_MESSAGE_RENDERED, onUserMessageRendered],
        [eventTypes.GENERATE_AFTER_DATA, () => restore('request-ready')],
        [eventTypes.GENERATION_STOPPED, () => restore('stopped')],
        [eventTypes.GENERATION_ENDED, () => restore('ended')],
        [eventTypes.CHAT_CHANGED, () => restore('chat-changed')],
    ].filter(([name]) => Boolean(name));

    for (const [name, handler] of bindings) {
        eventSource.on(name, handler);
    }

    return {
        restore,
        isActive: () => Boolean(active),
        destroy() {
            restore('destroyed');
            for (const [name, handler] of bindings) {
                eventSource.removeListener?.(name, handler);
            }
        },
    };
}

const BODY_FIELD_NAMES = ['body', 'content', 'text', 'response'];

function extractBodyFromArguments(argumentsText) {
    if (typeof argumentsText !== 'string') {
        return null;
    }

    try {
        const value = JSON.parse(argumentsText);
        if (!value || typeof value !== 'object' || Array.isArray(value)) {
            return null;
        }
        for (const field of BODY_FIELD_NAMES) {
            if (typeof value[field] === 'string' && value[field].length > 0) {
                return value[field];
            }
        }
    } catch {
        // Unknown or incomplete arguments are intentionally left unchanged.
    }
    return null;
}

function extractBodyFromMessage(message) {
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    for (const toolCall of toolCalls) {
        const body = extractBodyFromArguments(toolCall?.function?.arguments);
        if (body !== null) {
            return body;
        }
    }
    return extractBodyFromArguments(message?.function_call?.arguments);
}

/** Add visible content only when content is absent and tool args contain a known body field. */
export function normalizeCompletionObject(value) {
    if (!value || typeof value !== 'object' || value.error || !Array.isArray(value.choices)) {
        return { changed: false, value };
    }

    let changed = false;
    const choices = value.choices.map((choice) => {
        if (!choice?.message || (typeof choice.message.content === 'string' && choice.message.content.length > 0)) {
            return choice;
        }
        const body = extractBodyFromMessage(choice.message);
        if (body === null) {
            return choice;
        }
        changed = true;
        return {
            ...choice,
            message: { ...choice.message, content: body },
        };
    });

    return changed ? { changed: true, value: { ...value, choices } } : { changed: false, value };
}

function createStreamEventNormalizer(kind) {
    const argumentBuffers = new Map();
    const injectedChoices = new Set();

    function collect(choice) {
        const choiceIndex = choice?.index ?? 0;
        const toolCalls = Array.isArray(choice?.delta?.tool_calls) ? choice.delta.tool_calls : [];
        for (const toolCall of toolCalls) {
            const fragment = toolCall?.function?.arguments;
            if (typeof fragment !== 'string') {
                continue;
            }
            const toolIndex = toolCall.index ?? 0;
            const key = `${choiceIndex}:${toolIndex}`;
            argumentBuffers.set(key, (argumentBuffers.get(key) ?? '') + fragment);
        }
    }

    function bodyForChoice(choiceIndex) {
        for (const [key, text] of argumentBuffers) {
            if (key.startsWith(`${choiceIndex}:`)) {
                const body = extractBodyFromArguments(text);
                if (body !== null) {
                    return body;
                }
            }
        }
        return null;
    }

    function normalizeData(value) {
        const direct = normalizeCompletionObject(value);
        if (direct.changed || !value || typeof value !== 'object' || value.error || !Array.isArray(value.choices)) {
            return direct;
        }

        let changed = false;
        const choices = value.choices.map((choice) => {
            collect(choice);
            const choiceIndex = choice?.index ?? 0;
            const existingContent = choice?.delta?.content;
            if (choice?.finish_reason == null
                || injectedChoices.has(choiceIndex)
                || (typeof existingContent === 'string' && existingContent.length > 0)) {
                return choice;
            }

            const body = bodyForChoice(choiceIndex);
            if (body === null) {
                return choice;
            }

            injectedChoices.add(choiceIndex);
            changed = true;
            return {
                ...choice,
                delta: { ...(choice.delta ?? {}), content: body },
            };
        });

        return changed ? { changed: true, value: { ...value, choices } } : { changed: false, value };
    }

    return function normalizeLine(line) {
        let prefix = '';
        let jsonText = line;
        if (kind === 'sse') {
            const match = line.match(/^(\s*data:\s?)(.*)$/);
            if (!match || match[2] === '[DONE]') {
                return line;
            }
            prefix = match[1];
            jsonText = match[2];
        } else if (line.trim().length === 0) {
            return line;
        }

        try {
            const parsed = JSON.parse(jsonText);
            const normalized = normalizeData(parsed);
            return normalized.changed ? `${prefix}${JSON.stringify(normalized.value)}` : line;
        } catch {
            return line;
        }
    };
}

function transformLineStream(stream, kind) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const normalizeLine = createStreamEventNormalizer(kind);
    let buffer = '';

    return stream.pipeThrough(new TransformStream({
        transform(chunk, controller) {
            buffer += decoder.decode(chunk, { stream: true });
            let newlineIndex;
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const rawLine = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                const hasCarriageReturn = rawLine.endsWith('\r');
                const line = hasCarriageReturn ? rawLine.slice(0, -1) : rawLine;
                controller.enqueue(encoder.encode(`${normalizeLine(line)}${hasCarriageReturn ? '\r' : ''}\n`));
            }
        },
        flush(controller) {
            buffer += decoder.decode();
            if (buffer.length > 0) {
                controller.enqueue(encoder.encode(normalizeLine(buffer)));
            }
        },
    }));
}

function responseWithBody(response, body) {
    const headers = new Headers(response.headers);
    headers.delete('content-length');
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
    });
}

export async function normalizeChatCompletionResponse(response) {
    if (!(response instanceof Response) || !response.ok || !response.body) {
        return response;
    }

    const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (contentType.includes('text/event-stream')) {
        return responseWithBody(response, transformLineStream(response.body, 'sse'));
    }
    if (contentType.includes('application/x-ndjson') || contentType.includes('application/ndjson')) {
        return responseWithBody(response, transformLineStream(response.body, 'ndjson'));
    }
    if (!contentType.includes('application/json')) {
        return response;
    }

    try {
        const parsed = await response.clone().json();
        const normalized = normalizeCompletionObject(parsed);
        return normalized.changed
            ? responseWithBody(response, JSON.stringify(normalized.value))
            : response;
    } catch {
        return response;
    }
}

function isScopedRequest(input, init, baseUrl) {
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (method !== 'POST') {
        return false;
    }

    try {
        const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url, baseUrl);
        return url.pathname === CHAT_COMPLETION_ENDPOINT;
    } catch {
        return false;
    }
}

/** Install only while enabled; unrelated fetch calls are returned untouched. */
export function createScopedFetchNormalizer(windowObject) {
    let originalFetch = null;
    let wrappedFetch = null;
    let enabled = false;
    let activeWrapper = null;

    function enable() {
        if (enabled) {
            return;
        }
        enabled = true;
        originalFetch = windowObject.fetch;
        const delegateFetch = originalFetch;
        const wrapperToken = {};
        activeWrapper = wrapperToken;
        wrappedFetch = async function base64ComposerFetch(input, init) {
            const response = await delegateFetch.call(this, input, init);
            if (!enabled
                || activeWrapper !== wrapperToken
                || !isScopedRequest(input, init, windowObject.location?.href)) {
                return response;
            }
            return normalizeChatCompletionResponse(response);
        };
        windowObject.fetch = wrappedFetch;
    }

    function disable() {
        enabled = false;
        activeWrapper = null;
        if (windowObject.fetch === wrappedFetch) {
            windowObject.fetch = originalFetch;
            originalFetch = null;
            wrappedFetch = null;
        }
    }

    return { enable, disable, destroy: disable, isEnabled: () => enabled };
}
