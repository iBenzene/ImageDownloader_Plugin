// src/gmAdapter.ts

/**
 * 油猴脚本环境 GM_* API 适配层与测试注入桥接器
 * 提供统一跨域网络请求, 文件直接落盘以及跨页面持久化存储能力
 */

export interface GmHttpRequestOptions {
    method: 'GET' | 'POST' | 'HEAD';
    url: string;
    headers?: Record<string, string>;
    data?: string;
    timeout?: number;
    responseType?: 'text' | 'json' | 'blob' | 'arraybuffer';
    signal?: AbortSignal;
}

export interface GmHttpResponse {
    status: number;
    statusText: string;
    responseText: string;
    response?: unknown;
    headers: string;
}

export interface GmDownloadOptions {
    url: string;
    name: string;
    headers?: Record<string, string>;
    timeout?: number;
    signal?: AbortSignal;
    onProgress?: (loaded: number, total: number) => void;
}

export interface GmDownloadResult {
    /** 是否通过脚本管理器可观测的完成事件确认落盘成功 */
    confirmedByManager: boolean;
    bytesTransferred?: number;
}

export type ValueChangeListener<T = unknown> = (
    name: string,
    oldValue: T | undefined,
    newValue: T | undefined,
    remote: boolean
) => void;

export interface GmBridge {
    getValue<T>(key: string, defaultValue: T): T;
    setValue<T>(key: string, value: T): void;
    deleteValue(key: string): void;
    addValueChangeListener<T>(
        key: string,
        callback: ValueChangeListener<T>
    ): string | number;
    removeValueChangeListener(listenerId: string | number): void;
    httpRequest(options: GmHttpRequestOptions): Promise<GmHttpResponse>;
    downloadFile(options: GmDownloadOptions): Promise<GmDownloadResult>;
    registerMenuCommand(
        caption: string,
        onClick: () => void
    ): string | number | void;
    setClipboard(text: string): Promise<void>;
}

declare const GM_getValue:
    (<T>(key: string, defaultValue?: T) => T) | undefined;
declare const GM_setValue: (<T>(key: string, value: T) => void) | undefined;
declare const GM_deleteValue: ((key: string) => void) | undefined;
declare const GM_addValueChangeListener:
    | (<T>(key: string, cb: ValueChangeListener<T>) => string | number)
    | undefined;
declare const GM_removeValueChangeListener:
    ((id: string | number) => void) | undefined;
declare const GM_xmlhttpRequest:
    | ((details: {
          method?: string;
          url: string;
          headers?: Record<string, string>;
          data?: string;
          timeout?: number;
          responseType?: string;
          onload?: (res: {
              status: number;
              statusText: string;
              responseText?: string;
              response?: unknown;
              responseHeaders?: string;
          }) => void;
          onerror?: (err: {
              error?: string;
              statusText?: string;
              status?: number;
          }) => void;
          ontimeout?: () => void;
          onabort?: () => void;
      }) => { abort?: () => void } | void)
    | undefined;
declare const GM_download:
    | ((details: {
          url: string;
          name: string;
          headers?: Record<string, string>;
          saveAs?: boolean;
          timeout?: number;
          onload?: () => void;
          onerror?: (err: {
              error?: string;
              details?: { current?: string };
          }) => void;
          ontimeout?: () => void;
          onprogress?: (progress: { loaded?: number; total?: number }) => void;
      }) => { abort?: () => void } | void)
    | undefined;
declare const GM_registerMenuCommand:
    | ((caption: string, onClick: () => void) => string | number | void)
    | undefined;
declare const GM_setClipboard:
    ((data: string, info?: string) => void) | undefined;

/** 内存与本地存储后备容器, 用于单元测试或无油猴宿主环境 */
const memoryStore = new Map<string, string>();
const fallbackListeners = new Map<
    number,
    { key: string; cb: ValueChangeListener<unknown> }
>();
let nextListenerId = 1;

/** 创建标准宿主环境适配桥接实例 */
const createDefaultBridge = (): GmBridge => {
    return {
        addValueChangeListener<T>(
            key: string,
            callback: ValueChangeListener<T>
        ): string | number {
            try {
                if (typeof GM_addValueChangeListener === 'function') {
                    return GM_addValueChangeListener(
                        key,
                        (
                            name: string,
                            oldRaw: unknown,
                            newRaw: unknown,
                            remote: boolean
                        ) => {
                            const parseVal = (v: unknown): T | undefined => {
                                if (v === undefined || v === null) {
                                    return undefined;
                                }
                                if (typeof v === 'string') {
                                    try {
                                        return JSON.parse(v) as T;
                                    } catch {
                                        return v as unknown as T;
                                    }
                                }
                                return v as T;
                            };
                            callback(
                                name,
                                parseVal(oldRaw),
                                parseVal(newRaw),
                                remote
                            );
                        }
                    );
                }
            } catch {
                // 环境接口注册异常时平滑回退
            }
            const id = nextListenerId++;
            fallbackListeners.set(id, {
                cb: callback as ValueChangeListener<unknown>,
                key
            });
            return id;
        },

        deleteValue(key: string): void {
            try {
                if (typeof GM_deleteValue === 'function') {
                    GM_deleteValue(key);
                    return;
                }
            } catch {
                // 环境接口删除异常时平滑回退
            }
            if (typeof localStorage !== 'undefined') {
                localStorage.removeItem(key);
            } else {
                memoryStore.delete(key);
            }
        },

        downloadFile(options: GmDownloadOptions): Promise<GmDownloadResult> {
            if (options.signal?.aborted) {
                return Promise.reject(new Error('下载已取消'));
            }

            // 优先借助 GM_download 能力, 依据管理器回调事件判定文件真正落盘
            if (typeof GM_download === 'function') {
                return new Promise<GmDownloadResult>((resolve, reject) => {
                    let settled = false;
                    let lastLoaded = 0;

                    const handle = GM_download({
                        headers: options.headers,
                        name: options.name,
                        onerror: err => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            const code = err?.error || '';
                            const detail = err?.details?.current || '';
                            if (code === 'not_whitelisted') {
                                const msg =
                                    `文件扩展名未加入 Tampermonkey 下载白名单（${options.name}），` +
                                    '请在 Tampermonkey 设置 → 下载 BETA → 白名单中添加对应后缀';
                                reject(new Error(msg));
                            } else if (
                                code === 'not_permitted' ||
                                code === 'not_enabled'
                            ) {
                                reject(
                                    new Error(
                                        `Tampermonkey 下载权限未启用或域名未授权（${code}），请检查脚本 @connect 授权与下载设置`
                                    )
                                );
                            } else {
                                reject(
                                    new Error(
                                        `媒体下载失败${code ? ` (${code})` : ''}${detail ? `：${detail}` : ''}`
                                    )
                                );
                            }
                        },
                        onload: () => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            resolve({
                                bytesTransferred: lastLoaded,
                                confirmedByManager: true
                            });
                        },
                        onprogress: p => {
                            if (typeof p.loaded === 'number') {
                                lastLoaded = p.loaded;
                            }
                            if (
                                options.onProgress &&
                                typeof p.loaded === 'number'
                            ) {
                                options.onProgress(p.loaded, p.total ?? 0);
                            }
                        },
                        ontimeout: () => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            reject(
                                new Error(`媒体下载超时（${options.name}）`)
                            );
                        },
                        saveAs: false,
                        timeout: options.timeout ?? 180000,
                        url: options.url
                    });

                    if (options.signal) {
                        const onAbort = () => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            try {
                                handle?.abort?.();
                            } catch {
                                // 忽略中止操作时抛出的内部异常
                            }
                            reject(new Error('下载已取消'));
                        };
                        options.signal.addEventListener('abort', onAbort, {
                            once: true
                        });
                    }
                });
            }

            // 缺少 GM_download 时先拉取二进制流并在校验状态成功后再触发浏览器下载动作
            return (async () => {
                const res = await this.httpRequest({
                    headers: options.headers,
                    method: 'GET',
                    responseType: 'blob',
                    signal: options.signal,
                    timeout: options.timeout ?? 180000,
                    url: options.url
                });

                if (res.status !== 200) {
                    throw new Error(`资源下载失败，HTTP 状态码 ${res.status}`);
                }

                const blob = res.response as Blob | undefined;
                if (!blob || typeof blob.size !== 'number' || blob.size === 0) {
                    throw new Error('下载的媒体数据为空或无效');
                }

                if (
                    typeof document !== 'undefined' &&
                    typeof URL.createObjectURL === 'function'
                ) {
                    const objectUrl = URL.createObjectURL(blob);
                    try {
                        const a = document.createElement('a');
                        a.href = objectUrl;
                        a.download = options.name;
                        a.style.display = 'none';
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                    } finally {
                        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
                    }
                    return {
                        bytesTransferred: blob.size,
                        confirmedByManager: true
                    };
                }

                throw new Error(
                    '当前环境缺少 GM_download 且无法触发浏览器文件保存'
                );
            })();
        },

        getValue<T>(key: string, defaultValue: T): T {
            try {
                if (typeof GM_getValue === 'function') {
                    const raw = GM_getValue<string | undefined>(key, undefined);
                    if (raw === undefined) {
                        return defaultValue;
                    }
                    if (typeof raw === 'string') {
                        try {
                            return JSON.parse(raw) as T;
                        } catch {
                            return raw as unknown as T;
                        }
                    }
                    return raw as unknown as T;
                }
            } catch {
                // 环境接口读取异常时平滑回退
            }

            const raw =
                typeof localStorage !== 'undefined'
                    ? localStorage.getItem(key)
                    : (memoryStore.get(key) ?? null);
            if (raw === null || raw === undefined) {
                return defaultValue;
            }
            try {
                return JSON.parse(raw) as T;
            } catch {
                return defaultValue;
            }
        },

        httpRequest(options: GmHttpRequestOptions): Promise<GmHttpResponse> {
            if (options.signal?.aborted) {
                return Promise.reject(new Error('请求已取消'));
            }

            if (typeof GM_xmlhttpRequest === 'function') {
                return new Promise<GmHttpResponse>((resolve, reject) => {
                    let settled = false;
                    const handle = GM_xmlhttpRequest({
                        data: options.data,
                        headers: options.headers,
                        method: options.method,
                        onabort: () => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            reject(new Error('请求已取消'));
                        },
                        onerror: err => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            const detail = err?.error || err?.statusText || '';
                            if (
                                detail.toLowerCase().includes('connect') ||
                                detail.toLowerCase().includes('permission') ||
                                detail.toLowerCase().includes('disallowed')
                            ) {
                                reject(
                                    new Error(
                                        `跨域请求被脚本管理器拦截（请在 Tampermonkey 授权弹窗中允许访问该域名）：${detail || options.url}`
                                    )
                                );
                            } else {
                                reject(
                                    new Error(
                                        `网络请求失败${detail ? `：${detail}` : '（请检查服务端地址、网络连接或跨域 @connect 授权）'}`
                                    )
                                );
                            }
                        },
                        onload: res => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            resolve({
                                headers: res.responseHeaders || '',
                                response: res.response,
                                responseText:
                                    typeof res.responseText === 'string'
                                        ? res.responseText
                                        : '',
                                status: res.status,
                                statusText: res.statusText || ''
                            });
                        },
                        ontimeout: () => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            reject(
                                new Error(
                                    '请求超时，请检查网络连接或服务端响应速度'
                                )
                            );
                        },
                        responseType:
                            options.responseType === 'blob'
                                ? 'blob'
                                : undefined,
                        timeout: options.timeout ?? 30000,
                        url: options.url
                    });

                    if (options.signal) {
                        const onAbort = () => {
                            if (settled) {
                                return;
                            }
                            settled = true;
                            try {
                                handle?.abort?.();
                            } catch {
                                // 忽略中止操作时抛出的内部异常
                            }
                            reject(new Error('请求已取消'));
                        };
                        options.signal.addEventListener('abort', onAbort, {
                            once: true
                        });
                    }
                });
            }

            // 标准 fetch 实现, 用于测试环境或无 GM 扩展环境
            return (async () => {
                const controller = new AbortController();
                const timeoutId = setTimeout(
                    () => controller.abort(),
                    options.timeout ?? 30000
                );
                if (options.signal) {
                    options.signal.addEventListener(
                        'abort',
                        () => controller.abort(),
                        { once: true }
                    );
                }
                try {
                    const response = await fetch(options.url, {
                        body:
                            options.method === 'POST'
                                ? options.data
                                : undefined,
                        headers: options.headers,
                        method: options.method,
                        signal: controller.signal
                    });
                    if (options.responseType === 'blob') {
                        const blob = await response.blob();
                        return {
                            headers: '',
                            response: blob,
                            responseText: '',
                            status: response.status,
                            statusText: response.statusText
                        };
                    }
                    const text = await response.text();
                    return {
                        headers: '',
                        response: text,
                        responseText: text,
                        status: response.status,
                        statusText: response.statusText
                    };
                } catch (err: unknown) {
                    if (options.signal?.aborted) {
                        throw new Error('请求已取消', { cause: err });
                    }
                    const msg =
                        err instanceof Error ? err.message : String(err);
                    throw new Error(`网络请求失败：${msg}`, { cause: err });
                } finally {
                    clearTimeout(timeoutId);
                }
            })();
        },

        registerMenuCommand(
            caption: string,
            onClick: () => void
        ): string | number | void {
            try {
                if (typeof GM_registerMenuCommand === 'function') {
                    return GM_registerMenuCommand(caption, onClick);
                }
            } catch {
                // 忽略宿主菜单注册异常
            }
        },

        removeValueChangeListener(listenerId: string | number): void {
            try {
                if (typeof GM_removeValueChangeListener === 'function') {
                    GM_removeValueChangeListener(listenerId);
                    return;
                }
            } catch {
                // 环境接口注销异常时平滑回退
            }
            if (typeof listenerId === 'number') {
                fallbackListeners.delete(listenerId);
            }
        },

        async setClipboard(text: string): Promise<void> {
            try {
                if (typeof GM_setClipboard === 'function') {
                    GM_setClipboard(text, 'text');
                    return;
                }
            } catch {
                // 环境接口复制异常时平滑回退
            }
            if (
                typeof navigator !== 'undefined' &&
                navigator.clipboard?.writeText
            ) {
                await navigator.clipboard.writeText(text);
                return;
            }
            if (typeof document !== 'undefined') {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            }
        },

        setValue<T>(key: string, value: T): void {
            const serialized = JSON.stringify(value);
            const oldRaw =
                typeof localStorage !== 'undefined'
                    ? localStorage.getItem(key)
                    : memoryStore.get(key);

            try {
                if (typeof GM_setValue === 'function') {
                    GM_setValue(key, serialized);
                    return;
                }
            } catch {
                // 环境接口写入异常时平滑回退
            }

            if (typeof localStorage !== 'undefined') {
                localStorage.setItem(key, serialized);
            } else {
                memoryStore.set(key, serialized);
            }

            let oldVal: unknown = undefined;
            if (oldRaw !== null && oldRaw !== undefined) {
                try {
                    oldVal = JSON.parse(oldRaw);
                } catch {
                    oldVal = oldRaw;
                }
            }
            for (const { cb, key: k } of fallbackListeners.values()) {
                if (k === key) {
                    try {
                        cb(key, oldVal, value, false);
                    } catch {
                        // 忽略外部监听器抛出的异常
                    }
                }
            }
        }
    };
};

let activeBridge: GmBridge = createDefaultBridge();

export const getGmBridge = (): GmBridge => {
    return activeBridge;
};

export const setGmBridge = (customBridge: GmBridge): void => {
    activeBridge = customBridge;
};

export const resetGmBridge = (): void => {
    memoryStore.clear();
    fallbackListeners.clear();
    activeBridge = createDefaultBridge();
};
