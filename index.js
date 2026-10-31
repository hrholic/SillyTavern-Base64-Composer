import {
    clampPosition,
    createComposerController,
    createPointerInteraction,
} from './core.js';

const ROOT_ID = 'base64-composer-float';
const STORAGE_KEY = 'base64-composer-position-v1';
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

function createFloatingControl() {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.className = 'b64c-float';
    root.innerHTML = `
        <button class="b64c-action" type="button" aria-label="轻点整段转换为 Base64；长按打开更多选项" aria-expanded="false">
            <span aria-hidden="true">B64</span>
        </button>
        <div class="b64c-menu" role="menu" hidden>
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

    const textarea = document.querySelector(TEXTAREA_SELECTOR);
    if (!textarea) {
        console.warn('[Base64 Composer] #send_textarea was not found.');
        return;
    }

    const root = createFloatingControl();
    const action = root.querySelector('.b64c-action');
    const menu = root.querySelector('.b64c-menu');
    const undoButton = root.querySelector('.b64c-undo');
    const toast = root.querySelector('.b64c-toast');
    const controller = createComposerController(textarea);
    let toastTimer = null;
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

    function convert() {
        const result = controller.encode();
        syncUndoState();
        const messages = {
            encoded: '已整段转换',
            empty: '输入框为空',
            already_encoded: '已转换，请勿重复点击',
            round_trip_failed: '校验未通过，未替换',
            conversion_failed: '转换失败，未替换',
        };
        showStatus(messages[result.code] ?? '未执行转换');
    }

    function positionMenu() {
        const rect = action.getBoundingClientRect();
        const viewport = getViewport();
        root.classList.toggle('b64c-menu-below', rect.top < viewport.top + 72);
        root.classList.toggle('b64c-menu-align-left', rect.left < viewport.left + 120);
    }

    function setMenuOpen(open) {
        menu.hidden = !open;
        action.setAttribute('aria-expanded', String(open));
        if (open) {
            positionMenu();
            syncUndoState();
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
        onTap: convert,
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
        };
        showStatus(messages[result.code] ?? '未执行撤销');
    }

    function onTextareaInput() {
        const result = controller.handleInput();
        if (result.invalidated) {
            syncUndoState();
        }
    }

    function onOutsidePointerDown(event) {
        if (!menu.hidden && !root.contains(event.target)) {
            setMenuOpen(false);
        }
    }

    const savedPosition = loadSavedPosition();
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
    textarea.addEventListener('input', onTextareaInput);
    document.addEventListener('pointerdown', onOutsidePointerDown, true);
    window.addEventListener('resize', keepInViewport);
    window.visualViewport?.addEventListener('resize', keepInViewport);
    window.visualViewport?.addEventListener('scroll', keepInViewport);

    cleanupCurrentMount = () => {
        clearTimeout(toastTimer);
        interaction.destroy();
        action.removeEventListener('pointerdown', onPointerDown);
        action.removeEventListener('pointermove', onPointerMove);
        action.removeEventListener('pointerup', onPointerUp);
        action.removeEventListener('pointercancel', onPointerCancel);
        action.removeEventListener('contextmenu', onContextMenu);
        undoButton.removeEventListener('click', onUndo);
        textarea.removeEventListener('input', onTextareaInput);
        document.removeEventListener('pointerdown', onOutsidePointerDown, true);
        window.removeEventListener('resize', keepInViewport);
        window.visualViewport?.removeEventListener('resize', keepInViewport);
        window.visualViewport?.removeEventListener('scroll', keepInViewport);
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
