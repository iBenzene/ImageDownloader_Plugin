// src/ui/entryPosition.ts

export interface EntryPositionState {
    noteKey?: string;
    manual?: { x: number; y: number };
    drag?: { pointerId: number; offsetX: number; offsetY: number };
}

export const resetEntryPosition = (
    state: EntryPositionState,
    noteKey: string | undefined
): void => {
    if (state.noteKey === noteKey) {
        return;
    }
    state.noteKey = noteKey;
    state.manual = undefined;
    state.drag = undefined;
};

const placeEntryBar = (
    bar: HTMLElement,
    view: Window,
    point: { x: number; y: number }
): void => {
    const rect = bar.getBoundingClientRect();
    const halfWidth = rect.width / 2;
    const halfHeight = rect.height / 2;
    bar.style.left = `${Math.max(8 + halfWidth, Math.min(view.innerWidth - 8 - halfWidth, point.x))}px`;
    bar.style.top = `${Math.max(8 + halfHeight, Math.min(view.innerHeight - 8 - halfHeight, point.y))}px`;
};

/** 定位快捷操作悬浮栏至笔记媒体顶部居中位置, 用户手动拖拽后保持自定义偏移 */
export const positionEntryBar = (
    bar: HTMLElement,
    doc: Document,
    view: Window,
    state?: EntryPositionState
): void => {
    const scopes = doc.querySelectorAll('#noteContainer, .note-container');
    const roots: ParentNode[] = scopes.length ? Array.from(scopes) : [doc];
    const mediaSelectors = [
        '.media-container',
        '.player-container',
        '.xgplayer',
        '[class*="video-player"]',
        '.note-slider',
        '.swiper',
        'video',
        '.note-slider-img'
    ];
    let mediaRect: DOMRect | undefined;
    for (const root of roots) {
        for (const selector of mediaSelectors) {
            for (const media of root.querySelectorAll<HTMLElement>(selector)) {
                const rect = media.getBoundingClientRect();
                const outOfBounds =
                    rect.width < 120 ||
                    rect.height < 100 ||
                    rect.bottom <= 0 ||
                    rect.top >= view.innerHeight ||
                    rect.right <= 0 ||
                    rect.left >= view.innerWidth;
                if (outOfBounds) {
                    continue;
                }
                if (view.getComputedStyle(media).visibility === 'hidden') {
                    continue;
                }
                mediaRect = rect;
                break;
            }
            if (mediaRect) {
                break;
            }
        }
        if (mediaRect) {
            break;
        }
    }

    // 等待笔记媒体元素渲染就绪后再显示操作栏, 避免覆盖无关网页内容
    bar.style.visibility = mediaRect ? 'visible' : 'hidden';
    if (!mediaRect) {
        return;
    }
    const left = Math.max(8, mediaRect.left + 16);
    const right = Math.min(view.innerWidth - 8, mediaRect.right - 16);
    bar.style.maxWidth = `${Math.max(0, right - left)}px`;
    placeEntryBar(
        bar,
        view,
        state?.manual ?? {
            x: (left + right) / 2,
            y:
                Math.max(8, mediaRect.top + 16) +
                bar.getBoundingClientRect().height / 2
        }
    );
};

export const observeEntryPosition = (
    root: ShadowRoot,
    state: EntryPositionState = {}
): void => {
    const doc = root.ownerDocument;
    const view = doc.defaultView;
    if (!view) {
        return;
    }
    root.addEventListener('pointerdown', event => {
        const e = event as PointerEvent;
        if (
            e.button !== 0 ||
            !e.isPrimary ||
            !(e.target as Element).closest('.bb-entry-drag')
        ) {
            return;
        }
        const bar = root.querySelector<HTMLElement>('.bb-entry-bar');
        if (!bar) {
            return;
        }
        const rect = bar.getBoundingClientRect();
        state.drag = {
            offsetX: e.clientX - rect.left - rect.width / 2,
            offsetY: e.clientY - rect.top - rect.height / 2,
            pointerId: e.pointerId
        };
        e.preventDefault();
        (root.host as HTMLElement).setPointerCapture?.(e.pointerId);
        bar.classList.add('is-dragging');
    });
    doc.addEventListener('pointermove', e => {
        if (!state.drag || e.pointerId !== state.drag.pointerId) {
            return;
        }
        const bar = root.querySelector<HTMLElement>('.bb-entry-bar');
        if (!bar || bar.hidden) {
            return;
        }
        state.manual = {
            x: e.clientX - state.drag.offsetX,
            y: e.clientY - state.drag.offsetY
        };
        placeEntryBar(bar, view, state.manual);
        const rect = bar.getBoundingClientRect();
        state.manual = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2
        };
    });
    const stopDrag = () => {
        const id = state.drag?.pointerId;
        state.drag = undefined;
        root.querySelector('.bb-entry-bar')?.classList.remove('is-dragging');
        const host = root.host as HTMLElement;
        if (id !== undefined && host.hasPointerCapture?.(id)) {
            host.releasePointerCapture(id);
        }
    };
    doc.addEventListener('pointerup', e => {
        if (e.pointerId === state.drag?.pointerId) {
            stopDrag();
        }
    });
    doc.addEventListener('pointercancel', e => {
        if (e.pointerId === state.drag?.pointerId) {
            stopDrag();
        }
    });
    root.host.addEventListener('lostpointercapture', stopDrag);
    view.addEventListener('blur', stopDrag);
    let pending = false;
    const update = () => {
        if (pending) {
            return;
        }
        pending = true;
        view.requestAnimationFrame(() => {
            pending = false;
            const bar = root.querySelector<HTMLElement>('.bb-entry-bar');
            if (bar && !bar.hidden) {
                positionEntryBar(bar, doc, view, state);
            }
        });
    };
    view.addEventListener('resize', update);
    doc.addEventListener('scroll', update, true);
    doc.addEventListener('transitionend', update, true);
    doc.addEventListener('animationend', update, true);
    new view.MutationObserver(update).observe(doc.body, {
        attributeFilter: ['class', 'style', 'hidden'],
        attributes: true,
        childList: true,
        subtree: true
    });
    if (view.ResizeObserver) {
        const resize = new view.ResizeObserver(update);
        resize.observe(doc.body);
        const mediaQuery =
            '#noteContainer, .note-container, .media-container, .player-container, .note-slider';
        // 在单页路由切换或图片懒加载完成后重新捕获媒体节点
        const observeMedia = () => {
            resize.disconnect();
            resize.observe(doc.body);
            doc.querySelectorAll(mediaQuery).forEach(element =>
                resize.observe(element)
            );
        };
        new view.MutationObserver(observeMedia).observe(doc.body, {
            childList: true,
            subtree: true
        });
        observeMedia();
    }
    update();
};
