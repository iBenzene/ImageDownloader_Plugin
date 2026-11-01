// src/pageAdapter.ts

import { BilibiliPageAdapter } from './bilibiliPageAdapter';
import { xhsPageAdapter } from './xhsPageAdapter';

export const pageAdapter =
    typeof window !== 'undefined' &&
    ['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(
        window.location.hostname
    )
        ? new BilibiliPageAdapter()
        : xhsPageAdapter;
