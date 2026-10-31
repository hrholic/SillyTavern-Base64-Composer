const BYTE_CHUNK_SIZE = 24 * 1024; // Divisible by 3, so joined Base64 chunks stay valid.

export const DEFAULT_ENCODING_SETTINGS = Object.freeze({
    mode: 'whole',
    chunkSize: 8,
    preserveTechnical: false,
});

/** Encode a JavaScript string as standard Base64 over its UTF-8 bytes. */
export function utf8ToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    const parts = [];

    for (let offset = 0; offset < bytes.length; offset += BYTE_CHUNK_SIZE) {
        const end = Math.min(offset + BYTE_CHUNK_SIZE, bytes.length);
        let binary = '';

        for (let index = offset; index < end; index += 1) {
            binary += String.fromCharCode(bytes[index]);
        }

        parts.push(btoa(binary));
    }

    return parts.join('');
}

/** Decode standard Base64 into a UTF-8 JavaScript string. */
export function base64ToUtf8(base64) {
    if (base64.length === 0) {
        return '';
    }

    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const byteLength = (base64.length / 4) * 3 - padding;
    const bytes = new Uint8Array(byteLength);
    const base64ChunkSize = 32 * 1024; // Divisible by 4.
    let byteOffset = 0;

    for (let offset = 0; offset < base64.length; offset += base64ChunkSize) {
        const binary = atob(base64.slice(offset, offset + base64ChunkSize));
        for (let index = 0; index < binary.length; index += 1) {
            bytes[byteOffset] = binary.charCodeAt(index);
            byteOffset += 1;
        }
    }

    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

export function normalizeEncodingSettings(settings = {}) {
    const mode = ['chunked', 'structured'].includes(settings.mode) ? settings.mode : 'whole';
    const parsedSize = Number.parseInt(settings.chunkSize, 10);
    return {
        mode,
        chunkSize: Number.isFinite(parsedSize) ? Math.min(1000, Math.max(1, parsedSize)) : 8,
        preserveTechnical: settings.preserveTechnical === true,
    };
}

/**
 * Split only a conservative set of technical Markdown/HTML forms. Unclosed or
 * ambiguous syntax remains ordinary text and is encoded.
 */
export function splitTechnicalSegments(text) {
    const pattern = /(```[^\r\n]*\r?\n[\s\S]*?```|~~~[^\r\n]*\r?\n[\s\S]*?~~~|`[^`\r\n]+`|\[[^\]\r\n]+\]\((?:[^()\r\n]|\([^()\r\n]*\))*\)|<\/?[A-Za-z][^>\r\n]*>)/g;
    const segments = [];
    let cursor = 0;

    for (const match of text.matchAll(pattern)) {
        if (match.index > cursor) {
            segments.push({ kind: 'plain', text: text.slice(cursor, match.index) });
        }
        segments.push({ kind: 'preserved', text: match[0] });
        cursor = match.index + match[0].length;
    }

    if (cursor < text.length) {
        segments.push({ kind: 'plain', text: text.slice(cursor) });
    }

    return segments.length > 0 ? segments : [{ kind: 'plain', text }];
}

export function decodeConversionParts(parts) {
    return parts.map((part) => part.kind === 'encoded' ? base64ToUtf8(part.base64) : part.text).join('');
}

export function decodeStructuredEnvelope(jsonText) {
    const envelope = JSON.parse(jsonText);
    if (envelope?.format !== 'sillytavern-base64-envelope'
        || envelope?.version !== 1
        || envelope?.encoding !== 'utf-8/base64'
        || !Array.isArray(envelope?.chunks)) {
        throw new Error('Invalid Base64 envelope.');
    }

    return envelope.chunks.map((chunk, offset) => {
        if (chunk?.index !== offset + 1 || typeof chunk?.data !== 'string') {
            throw new Error('Invalid or unordered Base64 envelope chunk.');
        }
        return base64ToUtf8(chunk.data);
    }).join('');
}

/** Create whole or independently decodable, numbered Base64 output. */
export function encodeText(text, requestedSettings = {}) {
    const settings = normalizeEncodingSettings(requestedSettings);
    const sourceSegments = settings.preserveTechnical && settings.mode !== 'structured'
        ? splitTechnicalSegments(text)
        : [{ kind: 'plain', text }];
    const parts = [];

    for (const segment of sourceSegments) {
        if (segment.kind === 'preserved') {
            parts.push(segment);
            continue;
        }

        const codePoints = Array.from(segment.text);
        const size = settings.mode === 'whole' ? Math.max(1, codePoints.length) : settings.chunkSize;
        for (let offset = 0; offset < codePoints.length; offset += size) {
            const chunk = codePoints.slice(offset, offset + size).join('');
            parts.push({ kind: 'encoded', base64: utf8ToBase64(chunk) });
        }
    }

    const encodedParts = parts.filter((part) => part.kind === 'encoded');
    if (encodedParts.length === 0) {
        return { output: text, parts, settings, changed: false };
    }

    let output;
    if (settings.mode === 'structured') {
        output = JSON.stringify({
            format: 'sillytavern-base64-envelope',
            version: 1,
            encoding: 'utf-8/base64',
            chunks: encodedParts.map((part, offset) => ({
                index: offset + 1,
                data: part.base64,
            })),
        }, null, 2);
    } else if (settings.mode === 'chunked') {
        let index = 0;
        output = parts.map((part) => {
            if (part.kind === 'preserved') {
                return part.text;
            }
            index += 1;
            return `${index}/${encodedParts.length}:${part.base64}`;
        }).join('\n');
    } else {
        output = parts.map((part) => part.kind === 'encoded' ? part.base64 : part.text).join('');
    }

    return { output, parts, settings, changed: output !== text };
}

function defaultDispatchInput(textarea) {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * State machine for safe textarea replacement and undo.
 * It never sends a message and never reads or writes chat history.
 */
export function createComposerController(
    textareaOrResolver,
    dispatchInput = defaultDispatchInput,
    getEncodingSettings = () => DEFAULT_ENCODING_SETTINGS,
) {
    let undoRecord = null;
    let internalWrite = false;

    const resolveTextarea = typeof textareaOrResolver === 'function'
        ? textareaOrResolver
        : () => textareaOrResolver;

    function isAvailable(textarea) {
        return Boolean(textarea) && (!('isConnected' in textarea) || textarea.isConnected);
    }

    function replaceValue(textarea, value) {
        internalWrite = true;
        try {
            textarea.value = value;
            dispatchInput(textarea);
        } finally {
            internalWrite = false;
        }
    }

    return {
        encode() {
            const textarea = resolveTextarea();
            if (!isAvailable(textarea)) {
                return { ok: false, code: 'no_target' };
            }

            const original = textarea.value;

            if (original.length === 0) {
                return { ok: false, code: 'empty' };
            }

            if (undoRecord?.textarea === textarea && original === undoRecord.encoded) {
                return { ok: false, code: 'already_encoded' };
            }

            try {
                const conversion = encodeText(original, getEncodingSettings());
                const encoded = conversion.output;
                const decoded = conversion.settings.mode === 'structured'
                    ? decodeStructuredEnvelope(encoded)
                    : decodeConversionParts(conversion.parts);

                if (decoded !== original) {
                    return { ok: false, code: 'round_trip_failed' };
                }

                if (!conversion.changed) {
                    return { ok: false, code: 'nothing_to_encode' };
                }

                undoRecord = { textarea, original, encoded };
                replaceValue(textarea, encoded);
                return { ok: true, code: 'encoded', encoded, settings: conversion.settings };
            } catch (error) {
                console.error('[Base64 Composer] Conversion failed.', error);
                return { ok: false, code: 'conversion_failed' };
            }
        },

        undo() {
            if (!undoRecord) {
                return { ok: false, code: 'nothing_to_undo' };
            }

            if (!isAvailable(undoRecord.textarea)) {
                undoRecord = null;
                return { ok: false, code: 'target_unavailable' };
            }

            if (undoRecord.textarea.value !== undoRecord.encoded) {
                undoRecord = null;
                return { ok: false, code: 'content_changed' };
            }

            const original = undoRecord.original;
            const textarea = undoRecord.textarea;
            undoRecord = null;
            replaceValue(textarea, original);
            return { ok: true, code: 'undone' };
        },

        handleInput(eventOrTextarea = resolveTextarea()) {
            const textarea = eventOrTextarea?.target ?? eventOrTextarea;
            if (!internalWrite && undoRecord?.textarea === textarea) {
                undoRecord = null;
                return { invalidated: true };
            }
            return { invalidated: false };
        },

        canUndo() {
            return Boolean(undoRecord)
                && isAvailable(undoRecord.textarea)
                && undoRecord.textarea.value === undoRecord.encoded;
        },
    };
}

/** Route actions to an active message editor before the bottom composer. */
export function createTextareaTargetResolver(documentObject, {
    editSelector = 'textarea.edit_textarea',
    composerSelector = '#send_textarea',
    isVisible = (element) => {
        if (!element?.isConnected || element.hidden) {
            return false;
        }
        const view = element.ownerDocument?.defaultView;
        const style = view?.getComputedStyle?.(element);
        if (style?.display === 'none' || style?.visibility === 'hidden') {
            return false;
        }
        return typeof element.getClientRects !== 'function' || element.getClientRects().length > 0;
    },
} = {}) {
    const focusOrder = new WeakMap();
    let focusSequence = 0;

    function recordFocus(target) {
        if (target?.matches?.(editSelector)) {
            focusSequence += 1;
            focusOrder.set(target, focusSequence);
        }
    }

    function resolve() {
        const editors = [...documentObject.querySelectorAll(editSelector)].filter(isVisible);
        if (editors.length > 0) {
            if (editors.includes(documentObject.activeElement)) {
                return documentObject.activeElement;
            }
            return editors.reduce((latest, editor) => {
                return (focusOrder.get(editor) ?? 0) >= (focusOrder.get(latest) ?? 0) ? editor : latest;
            });
        }
        return documentObject.querySelector(composerSelector);
    }

    return { recordFocus, resolve };
}

/** Clamp a floating control to the current (possibly mobile visual) viewport. */
export function clampPosition(position, size, viewport, margin = 8) {
    const minX = viewport.left + margin;
    const minY = viewport.top + margin;
    const maxX = Math.max(minX, viewport.left + viewport.width - size.width - margin);
    const maxY = Math.max(minY, viewport.top + viewport.height - size.height - margin);

    return {
        x: Math.min(maxX, Math.max(minX, position.x)),
        y: Math.min(maxY, Math.max(minY, position.y)),
    };
}

/**
 * Pointer interaction state machine. A short tap activates immediately on
 * release; holding opens options; moving becomes a drag and cancels both.
 */
export function createPointerInteraction({
    onTap,
    onLongPress,
    onDragStart = () => {},
    onDrag = () => {},
    onDragEnd = () => {},
    longPressDelay = 500,
    threshold = 7,
    schedule = setTimeout,
    cancelSchedule = clearTimeout,
}) {
    let activePointer = null;

    function cancelLongPress() {
        if (activePointer?.longPressTimer !== null) {
            cancelSchedule(activePointer.longPressTimer);
            activePointer.longPressTimer = null;
        }
    }

    return {
        pointerDown(event) {
            if (activePointer || (event.button !== undefined && event.button !== 0)) {
                return false;
            }

            const pointer = {
                id: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                dragging: false,
                longPressed: false,
                longPressTimer: null,
            };
            activePointer = pointer;
            pointer.longPressTimer = schedule(() => {
                if (activePointer !== pointer || pointer.dragging) {
                    return;
                }
                pointer.longPressTimer = null;
                pointer.longPressed = true;
                onLongPress(event);
            }, longPressDelay);
            return true;
        },

        pointerMove(event) {
            if (!activePointer || event.pointerId !== activePointer.id) {
                return false;
            }

            const dx = event.clientX - activePointer.startX;
            const dy = event.clientY - activePointer.startY;

            if (!activePointer.dragging && Math.hypot(dx, dy) >= threshold) {
                activePointer.dragging = true;
                cancelLongPress();
                onDragStart(event);
            }

            if (activePointer.dragging) {
                onDrag({ dx, dy, event });
                return true;
            }

            return false;
        },

        pointerUp(event) {
            if (!activePointer || event.pointerId !== activePointer.id) {
                return 'ignored';
            }

            const wasDragging = activePointer.dragging;
            const wasLongPress = activePointer.longPressed;
            cancelLongPress();
            activePointer = null;

            if (wasDragging) {
                onDragEnd(event);
                return 'drag';
            }

            if (wasLongPress) {
                return 'long-press';
            }

            onTap(event);
            return 'tap';
        },

        pointerCancel(event) {
            if (!activePointer || event.pointerId !== activePointer.id) {
                return false;
            }
            const wasDragging = activePointer.dragging;
            cancelLongPress();
            activePointer = null;
            if (wasDragging) {
                onDragEnd(event);
            }
            return true;
        },

        destroy() {
            cancelLongPress();
            activePointer = null;
        },
    };
}
