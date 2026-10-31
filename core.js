const BYTE_CHUNK_SIZE = 24 * 1024; // Divisible by 3, so joined Base64 chunks stay valid.

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

function defaultDispatchInput(textarea) {
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * State machine for safe textarea replacement and undo.
 * It never sends a message and never reads or writes chat history.
 */
export function createComposerController(textarea, dispatchInput = defaultDispatchInput) {
    let undoRecord = null;
    let internalWrite = false;

    function replaceValue(value) {
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
            const original = textarea.value;

            if (original.length === 0) {
                return { ok: false, code: 'empty' };
            }

            if (undoRecord && original === undoRecord.encoded) {
                return { ok: false, code: 'already_encoded' };
            }

            try {
                const encoded = utf8ToBase64(original);
                const decoded = base64ToUtf8(encoded);

                if (decoded !== original) {
                    return { ok: false, code: 'round_trip_failed' };
                }

                undoRecord = { original, encoded };
                replaceValue(encoded);
                return { ok: true, code: 'encoded', encoded };
            } catch (error) {
                console.error('[Base64 Composer] Conversion failed.', error);
                return { ok: false, code: 'conversion_failed' };
            }
        },

        undo() {
            if (!undoRecord) {
                return { ok: false, code: 'nothing_to_undo' };
            }

            if (textarea.value !== undoRecord.encoded) {
                undoRecord = null;
                return { ok: false, code: 'content_changed' };
            }

            const original = undoRecord.original;
            undoRecord = null;
            replaceValue(original);
            return { ok: true, code: 'undone' };
        },

        handleInput() {
            if (!internalWrite && undoRecord) {
                undoRecord = null;
                return { invalidated: true };
            }
            return { invalidated: false };
        },

        canUndo() {
            return Boolean(undoRecord) && textarea.value === undoRecord.encoded;
        },
    };
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
