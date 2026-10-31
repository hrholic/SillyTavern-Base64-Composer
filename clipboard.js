/** Copy only after an explicit user action. Returns false instead of claiming success. */
export async function copyText(text, {
    navigatorObject = globalThis.navigator,
    documentObject = globalThis.document,
} = {}) {
    if (typeof text !== 'string') {
        return false;
    }

    try {
        if (typeof navigatorObject?.clipboard?.writeText === 'function') {
            await navigatorObject.clipboard.writeText(text);
            return true;
        }
    } catch {
        // Older Android/iOS WebViews may expose Clipboard API but reject it.
    }

    if (!documentObject?.body || typeof documentObject.createElement !== 'function') {
        return false;
    }

    const field = documentObject.createElement('textarea');
    field.value = text;
    field.setAttribute?.('readonly', '');
    field.style.position = 'fixed';
    field.style.left = '-9999px';
    field.style.top = '0';
    documentObject.body.append(field);

    let copied = false;
    try {
        field.focus?.();
        field.select?.();
        field.setSelectionRange?.(0, field.value.length);
        copied = documentObject.execCommand?.('copy') === true;
    } catch {
        copied = false;
    } finally {
        field.remove?.();
    }
    return copied;
}

