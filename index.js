import {
    clampPosition,
    createPointerInteraction,
    createTextareaTargetResolver,
    DEFAULT_ENCODING_SETTINGS,
    normalizeEncodingSettings,
} from './core.js';
import {
    buildRequestTransport,
    createScopedFetchNormalizer,
    createTemporaryMessageAdapter,
    DEFAULT_PIPELINE_SETTINGS,
    inspectMessageTransportSnapshot,
    MESSAGE_TRANSPORT_APPLIED,
    normalizePipelineSettings,
} from './pipeline.js';
import { copyText } from './clipboard.js';

const ROOT_ID = 'base64-composer-float';
const STORAGE_KEY = 'base64-composer-position-v1';
const SETTINGS_KEY = 'base64-composer-settings-v1';
const TEXTAREA_SELECTOR = '#send_textarea';

let cleanupCurrentMount = null;

function getViewport() {
    const visual = window.visualViewport;
    return {
        left: visual?.offsetLeft ?? 0,
        top: visual?.offsetTop ?? 0,
        width: visual?.width ?? window.innerWidth,
        height: visual?.height ?? window.innerHeight,
    };
}

function loadSavedPosition() {
    try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (Number.isFinite(value?.x) && Number.isFinite(value?.y)) {
            return value;
        }
    } catch {
        // Ignore unavailable storage and malformed values.
    }
    return null;
}

function savePosition(position) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(position));
    } catch {
        // Position persistence is optional.
    }
}

function loadSettings() {
    try {
        const stored = JSON.parse(localStorage.getItem(SETTINGS_KEY)) ?? {};
        return {
            ...normalizeEncodingSettings(stored),
            ...normalizePipelineSettings(stored),
            mode: 'structured',
            outgoingMode: 'chunked',
            theme: stored.theme === 'light' ? 'light' : 'dark',
        };
    } catch {
        return {
            ...DEFAULT_ENCODING_SETTINGS,
            ...DEFAULT_PIPELINE_SETTINGS,
            mode: 'structured',
            outgoingMode: 'chunked',
            theme: 'dark',
        };
    }
}

function saveSettings(settings) {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
        // Settings persistence is optional.
    }
}

function createFloatingControl() {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'b64c-float';
    root.innerHTML = `
        <button class="b64c-action" type="button" aria-label="轻点切换发送时编码；长按打开更多选项" aria-expanded="false">
            <span aria-hidden="true">B64</span>
        </button>
        <div class="b64c-menu" role="menu" hidden>
            <div class="b64c-menu-head">
                <span>B64</span>
                <button class="b64c-theme" type="button" role="menuitem" aria-label="切换日间配色"></button>
            </div>
            <label class="b64c-field b64c-chunk-field">
                <span>每块字符</span>
                <input class="b64c-chunk-size" type="number" min="1" max="1000" step="1" inputmode="numeric" value="8">
            </label>
            <label class="b64c-check">
                <input class="b64c-outgoing" type="checkbox">
                <span>发送时编码</span>
            </label>
            <label class="b64c-check">
                <input class="b64c-response" type="checkbox">
                <span>响应正文提取</span>
            </label>
            <label class="b64c-check">
                <input class="b64c-protect-request" type="checkbox">
                <span>请求</span>
            </label>
            <label class="b64c-check">
                <input class="b64c-protect-database" type="checkbox">
                <span>数据库保护</span>
            </label>
            <details class="b64c-pipeline-hint">
                <summary>说明</summary>
                <div>发送时编码仅在请求装配时临时生效。“请求”保留注释（含 &lt;!-- Request: --&gt;）、指令标记、代码块和标签结构；“数据库保护”保留 data、MVU、UpdateVariable 等数据块。两项独立生效，普通正文仍编码。</div>
            </details>
            <details class="b64c-preview-wrap">
                <summary><span>实际发送预览</span><button class="b64c-copy" type="button">复制</button></summary>
                <pre class="b64c-preview"></pre>
            </details>
        </div>
        <div class="b64c-toast" role="status" aria-live="polite"></div>
    `;
    document.body.append(root);
    return root;
}

function mount() {
    cleanupCurrentMount?.();
    document.getElementById(ROOT_ID)?.remove();

    const root = createFloatingControl();
    const action = root.querySelector('.b64c-action');
    const menu = root.querySelector('.b64c-menu');
    const toast = root.querySelector('.b64c-toast');
    const chunkField = root.querySelector('.b64c-chunk-field');
    const chunkSizeInput = root.querySelector('.b64c-chunk-size');
    const outgoingInput = root.querySelector('.b64c-outgoing');
    const responseInput = root.querySelector('.b64c-response');
    const requestInput = root.querySelector('.b64c-protect-request');
    const databaseInput = root.querySelector('.b64c-protect-database');
    const preview = root.querySelector('.b64c-preview');
    const copyButton = root.querySelector('.b64c-copy');
    const themeButton = root.querySelector('.b64c-theme');
    let settings = loadSettings();
    const targetResolver = createTextareaTargetResolver(document, {
        composerSelector: TEXTAREA_SELECTOR,
    });
    const fetchNormalizer = createScopedFetchNormalizer(window);
    const context = globalThis.SillyTavern?.getContext?.();
    const temporaryMessageAdapter = context?.eventSource && context?.event_types
        ? createTemporaryMessageAdapter({
            eventSource: context.eventSource,
            eventTypes: context.event_types,
            getChat: () => context.chat,
            getSettings: () => settings,
            getTransportSettings: () => settings,
            onPreview: (text) => { preview.textContent = text; },
            onStateChange: ({ active }) => {
                root.classList.toggle('b64c-request-active', active);
                if (!active) {
                    scheduleBadgeSync();
                }
            },
        })
        : null;
    let toastTimer = null;
    let copyTimer = null;
    let badgeSyncTimer = null;
    let dragOrigin = null;

    function showStatus(message) {
        toast.textContent = message;
        toast.classList.add('b64c-toast-visible');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            toast.classList.remove('b64c-toast-visible');
        }, 1600);
    }

    function toggleOutgoing() {
        settings = { ...settings, outgoingAdapterEnabled: !settings.outgoingAdapterEnabled };
        saveSettings(settings);
        syncSettingsUI();
        updatePreview();
        if (!settings.outgoingAdapterEnabled) {
            temporaryMessageAdapter?.restore('disabled');
        }
        showStatus(settings.outgoingAdapterEnabled ? '发送时编码：已开启' : '发送时编码：已关闭');
    }

    function positionMenu() {
        const rect = action.getBoundingClientRect();
        const viewport = getViewport();
        const menuHeight = menu.getBoundingClientRect().height || 180;
        root.classList.toggle('b64c-menu-below', rect.top < viewport.top + menuHeight + 8);
        root.classList.toggle('b64c-menu-align-left', rect.left < viewport.left + 120);
    }

    function setMenuOpen(open) {
        menu.hidden = !open;
        action.setAttribute('aria-expanded', String(open));
        if (open) {
            positionMenu();
            updatePreview();
        }
    }

    function syncSettingsUI() {
        chunkSizeInput.value = String(settings.chunkSize);
        outgoingInput.checked = settings.outgoingAdapterEnabled;
        responseInput.checked = settings.responseNormalizerEnabled;
        requestInput.checked = settings.protectRequest;
        databaseInput.checked = settings.protectDatabase;
        chunkField.hidden = false;
        root.classList.toggle('b64c-send-enabled', settings.outgoingAdapterEnabled);
        root.dataset.theme = settings.theme;
        action.setAttribute('aria-pressed', String(settings.outgoingAdapterEnabled));
        action.setAttribute('aria-label', settings.outgoingAdapterEnabled
            ? '发送时编码已开启；轻点关闭，长按打开更多选项'
            : '发送时编码已关闭；轻点开启，长按打开更多选项');
        action.title = action.getAttribute('aria-label');
        themeButton.textContent = settings.theme === 'light' ? '☀' : '☾';
        themeButton.setAttribute('aria-label', settings.theme === 'light' ? '切换夜间配色' : '切换日间配色');
        themeButton.title = themeButton.getAttribute('aria-label');
    }

    function updatePreview() {
        if (!settings.outgoingAdapterEnabled) {
            preview.textContent = '发送时编码已关闭；不会修改请求。';
            return;
        }
        const targetText = targetResolver.resolve()?.value;
        const lastMessage = context?.chat?.at?.(-1);
        const source = typeof targetText === 'string' && targetText.length > 0
            ? targetText
            : lastMessage?.is_user && typeof lastMessage.mes === 'string'
                ? lastMessage.mes
                : '';
        preview.textContent = source.length > 0
            ? buildRequestTransport(source, settings)
            : '没有可预览的发送文本。';
    }

    function updateSettings() {
        settings = {
            ...normalizeEncodingSettings({
                mode: 'structured',
                chunkSize: chunkSizeInput.value,
                preserveTechnical: false,
            }),
            ...normalizePipelineSettings({
                outgoingAdapterEnabled: outgoingInput.checked,
                responseNormalizerEnabled: responseInput.checked,
                outgoingMode: 'chunked',
                protectRequest: requestInput.checked,
                protectDatabase: databaseInput.checked,
            }),
            theme: settings.theme,
        };
        syncSettingsUI();
        saveSettings(settings);
        updatePreview();
        if (settings.responseNormalizerEnabled) {
            fetchNormalizer.enable();
        } else {
            fetchNormalizer.disable();
        }
        if (!settings.outgoingAdapterEnabled) {
            temporaryMessageAdapter?.restore('disabled');
        }
    }

    function toggleTheme(event) {
        event.stopPropagation();
        settings = { ...settings, theme: settings.theme === 'light' ? 'dark' : 'light' };
        saveSettings(settings);
        syncSettingsUI();
    }

    async function copyPreview(event) {
        event.preventDefault();
        event.stopPropagation();
        clearTimeout(copyTimer);
        const copied = await copyText(preview.textContent ?? '');
        copyButton.textContent = copied ? '已复制' : '复制失败';
        copyTimer = setTimeout(() => {
            copyButton.textContent = '复制';
        }, 1200);
    }

    function applyPosition(position, persist = false) {
        const rect = action.getBoundingClientRect();
        const clamped = clampPosition(
            position,
            { width: rect.width, height: rect.height },
            getViewport(),
        );
        root.style.left = `${clamped.x}px`;
        root.style.top = `${clamped.y}px`;
        root.style.right = 'auto';
        root.style.bottom = 'auto';
        if (persist) {
            savePosition(clamped);
        }
        return clamped;
    }

    function keepInViewport() {
        const rect = action.getBoundingClientRect();
        applyPosition({ x: rect.left, y: rect.top });
    }

    const interaction = createPointerInteraction({
        onTap: toggleOutgoing,
        onLongPress: () => setMenuOpen(menu.hidden),
        onDragStart: () => {
            const rect = action.getBoundingClientRect();
            dragOrigin = { x: rect.left, y: rect.top };
            setMenuOpen(false);
            root.classList.add('b64c-dragging');
        },
        onDrag: ({ dx, dy }) => {
            if (dragOrigin) {
                applyPosition({ x: dragOrigin.x + dx, y: dragOrigin.y + dy });
            }
        },
        onDragEnd: () => {
            root.classList.remove('b64c-dragging');
            dragOrigin = null;
            const rect = action.getBoundingClientRect();
            applyPosition({ x: rect.left, y: rect.top }, true);
        },
    });

    function onPointerDown(event) {
        if (interaction.pointerDown(event)) {
            action.setPointerCapture?.(event.pointerId);
        }
    }

    function onPointerMove(event) {
        if (interaction.pointerMove(event)) {
            event.preventDefault();
        }
    }

    function onPointerUp(event) {
        const result = interaction.pointerUp(event);
        if (result !== 'ignored') {
            action.releasePointerCapture?.(event.pointerId);
        }
    }

    function onPointerCancel(event) {
        interaction.pointerCancel(event);
    }

    function onContextMenu(event) {
        event.preventDefault();
    }

    function syncMessageBadges() {
        document.querySelectorAll('#chat .b64c-message-badge, #chat .b64c-message-snapshot')
            .forEach((element) => element.remove());
        if (!Array.isArray(context?.chat)) {
            return;
        }

        context.chat.forEach((message, messageId) => {
            if (!message?.is_user || message.extra?.[MESSAGE_TRANSPORT_APPLIED] !== true) {
                return;
            }
            const messageElement = document.querySelector(`#chat .mes[mesid="${messageId}"]`);
            const messageText = messageElement?.querySelector('.mes_text');
            if (!messageText) {
                return;
            }
            const badge = document.createElement('button');
            badge.type = 'button';
            badge.className = 'b64c-message-badge';
            badge.textContent = '已编码';
            badge.title = '查看最近一次编码记录';
            badge.setAttribute('aria-expanded', 'false');

            const panel = document.createElement('div');
            panel.className = 'b64c-message-snapshot';
            panel.hidden = true;
            const inspected = inspectMessageTransportSnapshot(message);
            const snapshot = inspected.snapshot;

            if (!snapshot) {
                panel.textContent = '没有历史编码记录';
            } else {
                const toolbar = document.createElement('div');
                toolbar.className = 'b64c-snapshot-toolbar';
                const status = document.createElement('span');
                const capturedDate = new Date(snapshot.capturedAt);
                const time = Number.isNaN(capturedDate.getTime())
                    ? snapshot.capturedAt
                    : capturedDate.toLocaleString();
                const statusText = {
                    current: '最近生成',
                    edited: '编辑前记录',
                    different_swipe: '其他滑页记录',
                    invalid: '记录无法校验',
                }[inspected.status] ?? '最近生成';
                status.textContent = `${statusText} · ${time} · 不代表已接收`;

                const copy = document.createElement('button');
                copy.type = 'button';
                copy.className = 'b64c-snapshot-copy';
                copy.textContent = '复制';
                copy.addEventListener('click', async (event) => {
                    event.stopPropagation();
                    const copied = await copyText(snapshot.payload);
                    copy.textContent = copied ? '已复制' : '复制失败';
                    setTimeout(() => { copy.textContent = '复制'; }, 1200);
                });

                const content = document.createElement('pre');
                content.className = 'b64c-snapshot-content';
                content.textContent = snapshot.payload;
                toolbar.append(status, copy);
                panel.append(toolbar, content);
            }

            badge.addEventListener('click', () => {
                panel.hidden = !panel.hidden;
                badge.setAttribute('aria-expanded', String(!panel.hidden));
            });
            messageText.insertAdjacentElement('afterend', badge);
            badge.insertAdjacentElement('afterend', panel);
        });
    }

    function scheduleBadgeSync() {
        clearTimeout(badgeSyncTimer);
        badgeSyncTimer = setTimeout(syncMessageBadges, 0);
    }

    function onDocumentFocusIn(event) {
        targetResolver.recordFocus(event.target);
    }

    function onOutsidePointerDown(event) {
        if (!menu.hidden && !root.contains(event.target)) {
            setMenuOpen(false);
        }
    }

    const badgeEvents = context?.eventSource ? [
        context.event_types?.USER_MESSAGE_RENDERED,
        context.event_types?.MESSAGE_SENT,
        context.event_types?.MESSAGE_EDITED,
        context.event_types?.MESSAGE_UPDATED,
        context.event_types?.MESSAGE_DELETED,
        context.event_types?.MORE_MESSAGES_LOADED,
        context.event_types?.CHAT_CHANGED,
        context.event_types?.CHAT_LOADED,
    ].filter(Boolean) : [];

    const savedPosition = loadSavedPosition();
    syncSettingsUI();
    updatePreview();
    scheduleBadgeSync();
    if (settings.responseNormalizerEnabled) {
        fetchNormalizer.enable();
    }
    requestAnimationFrame(() => {
        if (savedPosition) {
            applyPosition(savedPosition);
        } else {
            keepInViewport();
        }
    });

    action.addEventListener('pointerdown', onPointerDown);
    action.addEventListener('pointermove', onPointerMove);
    action.addEventListener('pointerup', onPointerUp);
    action.addEventListener('pointercancel', onPointerCancel);
    action.addEventListener('contextmenu', onContextMenu);
    themeButton.addEventListener('click', toggleTheme);
    copyButton.addEventListener('click', copyPreview);
    chunkSizeInput.addEventListener('change', updateSettings);
    outgoingInput.addEventListener('change', updateSettings);
    responseInput.addEventListener('change', updateSettings);
    requestInput.addEventListener('change', updateSettings);
    databaseInput.addEventListener('change', updateSettings);
    document.addEventListener('focusin', onDocumentFocusIn, true);
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    window.addEventListener('resize', keepInViewport);
    window.visualViewport?.addEventListener('resize', keepInViewport);
    window.visualViewport?.addEventListener('scroll', keepInViewport);
    for (const eventName of badgeEvents) {
        context.eventSource.on(eventName, scheduleBadgeSync);
    }

    cleanupCurrentMount = () => {
        clearTimeout(toastTimer);
        clearTimeout(copyTimer);
        clearTimeout(badgeSyncTimer);
        interaction.destroy();
        action.removeEventListener('pointerdown', onPointerDown);
        action.removeEventListener('pointermove', onPointerMove);
        action.removeEventListener('pointerup', onPointerUp);
        action.removeEventListener('pointercancel', onPointerCancel);
        action.removeEventListener('contextmenu', onContextMenu);
        themeButton.removeEventListener('click', toggleTheme);
        copyButton.removeEventListener('click', copyPreview);
        chunkSizeInput.removeEventListener('change', updateSettings);
        outgoingInput.removeEventListener('change', updateSettings);
        responseInput.removeEventListener('change', updateSettings);
        requestInput.removeEventListener('change', updateSettings);
        databaseInput.removeEventListener('change', updateSettings);
        document.removeEventListener('focusin', onDocumentFocusIn, true);
        document.removeEventListener('pointerdown', onOutsidePointerDown, true);
        window.removeEventListener('resize', keepInViewport);
        window.visualViewport?.removeEventListener('resize', keepInViewport);
        window.visualViewport?.removeEventListener('scroll', keepInViewport);
        for (const eventName of badgeEvents) {
            context.eventSource.removeListener?.(eventName, scheduleBadgeSync);
        }
        document.querySelectorAll('#chat .b64c-message-badge, #chat .b64c-message-snapshot')
            .forEach((element) => element.remove());
        temporaryMessageAdapter?.destroy();
        fetchNormalizer.destroy();
        root.remove();
    };
}

function initialize() {
    const context = globalThis.SillyTavern?.getContext?.();
    const eventSource = context?.eventSource;
    const appReady = context?.event_types?.APP_READY;

    if (eventSource && appReady) {
        eventSource.on(appReady, () => setTimeout(mount, 0));
    } else if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount, { once: true });
    } else {
        mount();
    }
}

initialize();

