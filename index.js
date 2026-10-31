import {
    clampPosition,
    createComposerController,
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
    MESSAGE_TRANSPORT_APPLIED,
    normalizePipelineSettings,
} from './pipeline.js';

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
        };
    } catch {
        return { ...DEFAULT_ENCODING_SETTINGS, ...DEFAULT_PIPELINE_SETTINGS };
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
        <span class="b64c-send-status" hidden>发送时编码</span>
        <div class="b64c-menu" role="menu" hidden>
            <label class="b64c-field">
                <span>手动工具模式</span>
                <select class="b64c-mode">
                    <option value="whole">整段</option>
                    <option value="chunked">分块</option>
                    <option value="structured">结构化封装</option>
                </select>
            </label>
            <label class="b64c-field">
                <span>发送编码</span>
                <select class="b64c-outgoing-mode">
                    <option value="chunked">分块</option>
                    <option value="whole">整段</option>
                </select>
            </label>
            <label class="b64c-field b64c-chunk-field" hidden>
                <span>每块字符</span>
                <input class="b64c-chunk-size" type="number" min="1" max="1000" step="1" inputmode="numeric" value="8">
            </label>
            <label class="b64c-check">
                <input class="b64c-preserve" type="checkbox">
                <span>保留技术格式</span>
            </label>
            <div class="b64c-hint"></div>
            <div class="b64c-divider" aria-hidden="true"></div>
            <label class="b64c-check">
                <input class="b64c-outgoing" type="checkbox">
                <span>发送前处理</span>
            </label>
            <label class="b64c-check">
                <input class="b64c-response" type="checkbox">
                <span>响应正文提取</span>
            </label>
            <div class="b64c-pipeline-hint">仅支持普通发送与 OpenAI 兼容聊天生成接口；默认关闭</div>
            <details class="b64c-preview-wrap">
                <summary>实际发送预览</summary>
                <pre class="b64c-preview"></pre>
            </details>
            <button class="b64c-manual" type="button" role="menuitem">手动替换当前输入框</button>
            <button class="b64c-undo" type="button" role="menuitem" disabled>撤销转换</button>
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
    const undoButton = root.querySelector('.b64c-undo');
    const toast = root.querySelector('.b64c-toast');
    const modeSelect = root.querySelector('.b64c-mode');
    const chunkField = root.querySelector('.b64c-chunk-field');
    const chunkSizeInput = root.querySelector('.b64c-chunk-size');
    const outgoingModeSelect = root.querySelector('.b64c-outgoing-mode');
    const preserveInput = root.querySelector('.b64c-preserve');
    const outgoingInput = root.querySelector('.b64c-outgoing');
    const responseInput = root.querySelector('.b64c-response');
    const preview = root.querySelector('.b64c-preview');
    const manualButton = root.querySelector('.b64c-manual');
    const sendStatus = root.querySelector('.b64c-send-status');
    const settingsHint = root.querySelector('.b64c-hint');
    let settings = loadSettings();
    const targetResolver = createTextareaTargetResolver(document, {
        composerSelector: TEXTAREA_SELECTOR,
    });
    const controller = createComposerController(
        targetResolver.resolve,
        undefined,
        () => settings,
    );
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

    function syncUndoState() {
        undoButton.disabled = !controller.canUndo();
    }

    function manualConvert() {
        const result = controller.encode();
        syncUndoState();
        const messages = {
            empty: '输入框为空',
            already_encoded: '已转换，请勿重复点击',
            round_trip_failed: '校验未通过，未替换',
            conversion_failed: '转换失败，未替换',
            no_target: '没有可转换的输入框',
            nothing_to_encode: '没有需要编码的正文',
        };
        const successMessages = {
            whole: '已整段转换',
            chunked: '已分块转换',
            structured: '已结构化封装',
        };
        const successMessage = successMessages[result.settings?.mode] ?? '已转换';
        showStatus(result.ok ? successMessage : (messages[result.code] ?? '未执行转换'));
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
            syncUndoState();
            updatePreview();
        }
    }

    function syncSettingsUI() {
        modeSelect.value = settings.mode;
        outgoingModeSelect.value = settings.outgoingMode;
        chunkSizeInput.value = String(settings.chunkSize);
        preserveInput.checked = settings.preserveTechnical;
        outgoingInput.checked = settings.outgoingAdapterEnabled;
        responseInput.checked = settings.responseNormalizerEnabled;
        chunkField.hidden = settings.mode === 'whole' && settings.outgoingMode === 'whole';
        preserveInput.disabled = settings.mode === 'structured';
        sendStatus.hidden = !settings.outgoingAdapterEnabled;
        root.classList.toggle('b64c-send-enabled', settings.outgoingAdapterEnabled);
        action.setAttribute('aria-pressed', String(settings.outgoingAdapterEnabled));
        settingsHint.textContent = settings.mode === 'structured'
            ? '结构化封装会编码完整原文，不应用格式保留'
            : '围栏/行内代码、Markdown 链接、HTML 标签保持原样';
    }

    function updatePreview() {
        if (!settings.outgoingAdapterEnabled) {
            preview.textContent = '发送前处理已关闭；不会修改请求。';
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
                mode: modeSelect.value,
                chunkSize: chunkSizeInput.value,
                preserveTechnical: preserveInput.checked,
            }),
            ...normalizePipelineSettings({
                outgoingAdapterEnabled: outgoingInput.checked,
                responseNormalizerEnabled: responseInput.checked,
                outgoingMode: outgoingModeSelect.value,
            }),
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

    function onUndo(event) {
        event.stopPropagation();
        const result = controller.undo();
        syncUndoState();
        setMenuOpen(false);
        const messages = {
            undone: '已撤销',
            nothing_to_undo: '没有可撤销的转换',
            content_changed: '内容已改动，未覆盖',
            target_unavailable: '原编辑框已关闭，未覆盖',
        };
        showStatus(messages[result.code] ?? '未执行撤销');
    }

    function onManualConvert(event) {
        event.stopPropagation();
        manualConvert();
        setMenuOpen(false);
    }

    function syncMessageBadges() {
        document.querySelectorAll('#chat .b64c-message-badge').forEach((badge) => badge.remove());
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
            const badge = document.createElement('span');
            badge.className = 'b64c-message-badge';
            badge.textContent = '已编码';
            badge.title = '本条消息曾完成发送载荷编码；不代表模型已接收';
            messageText.insertAdjacentElement('afterend', badge);
        });
    }

    function scheduleBadgeSync() {
        clearTimeout(badgeSyncTimer);
        badgeSyncTimer = setTimeout(syncMessageBadges, 0);
    }

    function onDocumentInput(event) {
        const result = controller.handleInput(event);
        if (result.invalidated) {
            syncUndoState();
        }
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
    undoButton.addEventListener('click', onUndo);
    manualButton.addEventListener('click', onManualConvert);
    modeSelect.addEventListener('change', updateSettings);
    outgoingModeSelect.addEventListener('change', updateSettings);
    chunkSizeInput.addEventListener('change', updateSettings);
    preserveInput.addEventListener('change', updateSettings);
    outgoingInput.addEventListener('change', updateSettings);
    responseInput.addEventListener('change', updateSettings);
    document.addEventListener('input', onDocumentInput, true);
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
        clearTimeout(badgeSyncTimer);
        interaction.destroy();
        action.removeEventListener('pointerdown', onPointerDown);
        action.removeEventListener('pointermove', onPointerMove);
        action.removeEventListener('pointerup', onPointerUp);
        action.removeEventListener('pointercancel', onPointerCancel);
        action.removeEventListener('contextmenu', onContextMenu);
        undoButton.removeEventListener('click', onUndo);
        manualButton.removeEventListener('click', onManualConvert);
        modeSelect.removeEventListener('change', updateSettings);
        outgoingModeSelect.removeEventListener('change', updateSettings);
        chunkSizeInput.removeEventListener('change', updateSettings);
        preserveInput.removeEventListener('change', updateSettings);
        outgoingInput.removeEventListener('change', updateSettings);
        responseInput.removeEventListener('change', updateSettings);
        document.removeEventListener('input', onDocumentInput, true);
        document.removeEventListener('focusin', onDocumentFocusIn, true);
        document.removeEventListener('pointerdown', onOutsidePointerDown, true);
        window.removeEventListener('resize', keepInViewport);
        window.visualViewport?.removeEventListener('resize', keepInViewport);
        window.visualViewport?.removeEventListener('scroll', keepInViewport);
        for (const eventName of badgeEvents) {
            context.eventSource.removeListener?.(eventName, scheduleBadgeSync);
        }
        document.querySelectorAll('#chat .b64c-message-badge').forEach((badge) => badge.remove());
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
