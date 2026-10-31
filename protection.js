const WHOLE_TAG_NAMES = new Set([
    'recall',
    'supplement',
    'cb',
    'soul',
    'chaos',
    'data',
    'mvu',
    'updatevariable',
    'jsonpatch',
    'toolcall',
]);

const VOID_TAG_NAMES = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function normalizeTagName(name) {
    return name.toLowerCase().replace(/[-_]/g, '');
}

function appendSegment(segments, kind, text) {
    if (text.length === 0) {
        return;
    }
    const previous = segments.at(-1);
    if (previous?.kind === kind) {
        previous.text += text;
    } else {
        segments.push({ kind, text });
    }
}

function findMarkupEnd(text, start) {
    let quote = null;
    for (let index = start + 1; index < text.length; index += 1) {
        const character = text[index];
        if (quote !== null) {
            if (character === quote) {
                quote = null;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index + 1;
        }
    }
    return -1;
}

function readTag(text, start) {
    if (text[start] !== '<' || text.startsWith('<!--', start)) {
        return null;
    }
    const end = findMarkupEnd(text, start);
    if (end < 0) {
        return null;
    }
    const raw = text.slice(start, end);
    const match = raw.match(/^<\s*(\/?)\s*([^\s/>]+)[\s\S]*>$/);
    if (!match || match[2].startsWith('!') || match[2].startsWith('?')) {
        return null;
    }
    return {
        start,
        end,
        raw,
        closing: match[1] === '/',
        selfClosing: /\/\s*>$/.test(raw),
        name: match[2],
        normalizedName: normalizeTagName(match[2]),
    };
}

function findMatchingTag(text, openingTag) {
    let depth = 1;
    let cursor = openingTag.end;
    while (cursor < text.length) {
        const next = text.indexOf('<', cursor);
        if (next < 0) {
            return null;
        }
        if (text.startsWith('<!--', next)) {
            const commentEnd = text.indexOf('-->', next + 4);
            if (commentEnd < 0) {
                return null;
            }
            cursor = commentEnd + 3;
            continue;
        }
        const tag = readTag(text, next);
        if (!tag) {
            cursor = next + 1;
            continue;
        }
        if (tag.normalizedName === openingTag.normalizedName) {
            if (tag.closing) {
                depth -= 1;
                if (depth === 0) {
                    return tag;
                }
            } else if (!tag.selfClosing) {
                depth += 1;
            }
        }
        cursor = tag.end;
    }
    return null;
}

function readSquareTag(text, start) {
    const match = text.slice(start).match(/^\[(\/?)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*\]/);
    if (!match) {
        return null;
    }
    return {
        start,
        end: start + match[0].length,
        raw: match[0],
        closing: match[1] === '/',
        normalizedName: normalizeTagName(match[2]),
    };
}

function findMatchingSquareTag(text, openingTag) {
    let depth = 1;
    let cursor = openingTag.end;
    while (cursor < text.length) {
        const next = text.indexOf('[', cursor);
        if (next < 0) {
            return null;
        }
        const tag = readSquareTag(text, next);
        if (!tag) {
            cursor = next + 1;
            continue;
        }
        if (tag.normalizedName === openingTag.normalizedName) {
            depth += tag.closing ? -1 : 1;
            if (depth === 0) {
                return tag;
            }
        }
        cursor = tag.end;
    }
    return null;
}

function findSystemDirectiveEnd(text, start) {
    let depth = 0;
    let quote = null;
    for (let index = start; index < text.length; index += 1) {
        const character = text[index];
        if (quote !== null) {
            if (character === quote && text[index - 1] !== '\\') {
                quote = null;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '[') {
            depth += 1;
        } else if (character === ']') {
            depth -= 1;
            if (depth === 0) {
                const lineEnd = text.indexOf('\n', index + 1);
                return lineEnd < 0 ? text.length : lineEnd;
            }
        }
    }
    return text.length;
}

function appendRequestBodySegments(segments, body, protection) {
    const tokenPattern = /Character\(s\)|User|\s+/g;
    let cursor = 0;
    for (const match of body.matchAll(tokenPattern)) {
        if (match.index > cursor) {
            for (const segment of scanRange(body, cursor, match.index, protection)) {
                appendSegment(segments, segment.kind, segment.text);
            }
        }
        appendSegment(segments, 'preserved', match[0]);
        cursor = match.index + match[0].length;
    }
    if (cursor < body.length) {
        for (const segment of scanRange(body, cursor, body.length, protection)) {
            appendSegment(segments, segment.kind, segment.text);
        }
    }
}

function scanRange(text, start = 0, end = text.length, protection = {}) {
    const protectRequest = protection.protectRequest !== false;
    const protectDatabase = protection.protectDatabase !== false;
    const segments = [];
    let plainStart = start;
    let cursor = start;

    function preserve(from, to) {
        appendSegment(segments, 'plain', text.slice(plainStart, from));
        appendSegment(segments, 'preserved', text.slice(from, to));
        cursor = to;
        plainStart = to;
    }

    while (cursor < end) {
        if (protectRequest && text.startsWith('<!--', cursor)) {
            const close = text.indexOf('-->', cursor + 4);
            preserve(cursor, close < 0 || close + 3 > end ? end : close + 3);
            continue;
        }

        const fence = text.startsWith('```', cursor) ? '```'
            : text.startsWith('~~~', cursor) ? '~~~' : null;
        if (protectRequest && fence) {
            const close = text.indexOf(fence, cursor + fence.length);
            preserve(cursor, close < 0 || close + fence.length > end ? end : close + fence.length);
            continue;
        }

        if (protectRequest && text[cursor] === '`') {
            const lineEnd = text.indexOf('\n', cursor + 1);
            const close = text.indexOf('`', cursor + 1);
            preserve(cursor, close < 0 || (lineEnd >= 0 && close > lineEnd) || close + 1 > end ? end : close + 1);
            continue;
        }

        if (protectRequest && text.slice(cursor, cursor + 18).toUpperCase() === '[SYSTEM_DIRECTIVE:') {
            preserve(cursor, Math.min(end, findSystemDirectiveEnd(text, cursor)));
            continue;
        }

        if (protectDatabase && text[cursor] === '[') {
            const squareTag = readSquareTag(text, cursor);
            if (squareTag && !squareTag.closing && WHOLE_TAG_NAMES.has(squareTag.normalizedName)) {
                const closingTag = findMatchingSquareTag(text, squareTag);
                preserve(cursor, closingTag && closingTag.end <= end ? closingTag.end : end);
                continue;
            }
        }

        if (text[cursor] === '<') {
            const requestMatch = text.slice(cursor).match(/^<Request\s*:/i);
            if (protectRequest && requestMatch) {
                const requestEnd = findMarkupEnd(text, cursor);
                if (requestEnd < 0 || requestEnd > end) {
                    preserve(cursor, end);
                    continue;
                }
                appendSegment(segments, 'plain', text.slice(plainStart, cursor));
                appendSegment(segments, 'preserved', requestMatch[0]);
                appendRequestBodySegments(
                    segments,
                    text.slice(cursor + requestMatch[0].length, requestEnd - 1),
                    protection,
                );
                appendSegment(segments, 'preserved', '>');
                cursor = requestEnd;
                plainStart = requestEnd;
                continue;
            }

            const declarationEnd = text.startsWith('<!', cursor) || text.startsWith('<?', cursor)
                ? findMarkupEnd(text, cursor) : -1;
            if (protectRequest && declarationEnd > 0 && declarationEnd <= end) {
                preserve(cursor, declarationEnd);
                continue;
            }

            const openingTag = readTag(text, cursor);
            if (openingTag && openingTag.end <= end
                && (protectRequest || (protectDatabase && WHOLE_TAG_NAMES.has(openingTag.normalizedName)))) {
                if (openingTag.closing || openingTag.selfClosing
                    || VOID_TAG_NAMES.has(openingTag.normalizedName)) {
                    preserve(cursor, openingTag.end);
                    continue;
                }

                const closingTag = findMatchingTag(text, openingTag);
                if (!closingTag || closingTag.end > end) {
                    preserve(cursor, end);
                    continue;
                }
                if (protectDatabase && WHOLE_TAG_NAMES.has(openingTag.normalizedName)) {
                    preserve(cursor, closingTag.end);
                    continue;
                }

                appendSegment(segments, 'plain', text.slice(plainStart, cursor));
                appendSegment(segments, 'preserved', openingTag.raw);
                for (const segment of scanRange(text, openingTag.end, closingTag.start, protection)) {
                    appendSegment(segments, segment.kind, segment.text);
                }
                appendSegment(segments, 'preserved', closingTag.raw);
                cursor = closingTag.end;
                plainStart = closingTag.end;
                continue;
            }
        }

        cursor += 1;
    }

    appendSegment(segments, 'plain', text.slice(plainStart, end));
    return segments;
}

/**
 * Split text without executing or reserializing any directive. Preserved
 * segments keep their original bytes and positions; plain prose may be encoded.
 */
export function splitProtectedSegments(text, protection = {}) {
    return scanRange(text, 0, text.length, protection);
}


