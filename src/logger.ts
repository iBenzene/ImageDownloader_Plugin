// src/logger.ts

import { MAX_LOG_ENTRIES } from './constants';
import { storage } from './storage';
import { LogEntry, LogLevel } from './types';
import { formatRelativeDate, generateUUID, redactSensitive, toIso8601WithMs } from './utils';

/** 获取日志级别的本地化可读文案 */
export const getLogLevelName = (level: LogLevel): string => {
    switch (level) {
        case LogLevel.Debug:
            return '调试';
        case LogLevel.Info:
            return '信息';
        case LogLevel.Warn:
            return '警告';
        case LogLevel.Error:
            return '错误';
        default:
            return '信息';
    }
};

/**
 * 客户端日志记录与持久化服务
 * 自动对服务端令牌及敏感链接参数执行脱敏处理
 */
class LoggerService {
    /**
     * 写入单条运行日志
     * 写入前自动脱敏敏感参数, 超过上限时淘汰旧数据
     */
    public log(
        level: LogLevel,
        message: string,
        options?: { taskId?: string; context?: string }
    ): LogEntry {
        const settings = storage.getSettings();
        const safeMessage = redactSensitive(message, settings.serverToken);
        const safeContext = options?.context
            ? redactSensitive(options.context, settings.serverToken)
            : undefined;

        const entry: LogEntry = {
            id: generateUUID(),
            timestamp: toIso8601WithMs(),
            level,
            message: safeMessage,
            taskId: options?.taskId,
            context: safeContext,
        };

        const logs = storage.getLogs();
        logs.push(entry);
        const trimmed =
            logs.length > MAX_LOG_ENTRIES ? logs.slice(logs.length - MAX_LOG_ENTRIES) : logs;
        storage.setLogs(trimmed);
        return entry;
    }

    public debug(message: string, options?: { taskId?: string; context?: string }): LogEntry {
        return this.log(LogLevel.Debug, message, options);
    }

    public info(message: string, options?: { taskId?: string; context?: string }): LogEntry {
        return this.log(LogLevel.Info, message, options);
    }

    public warn(message: string, options?: { taskId?: string; context?: string }): LogEntry {
        return this.log(LogLevel.Warn, message, options);
    }

    public error(message: string, options?: { taskId?: string; context?: string }): LogEntry {
        return this.log(LogLevel.Error, message, options);
    }

    /**
     * 获取按级别与关键字筛选后的日志记录列表
     * 结果按时间逆序排列, 最新记录在前
     */
    public getFilteredLogs(filter?: {
        minLevel?: LogLevel;
        keyword?: string;
        taskId?: string;
    }): LogEntry[] {
        const settings = storage.getSettings();
        const minLevel = filter?.minLevel ?? settings.logDisplayLevel;
        const keyword = (filter?.keyword || '').trim().toLowerCase();
        const taskId = filter?.taskId;

        return storage
            .getLogs()
            .filter(entry => {
                if (entry.level < minLevel) { return false; }
                if (taskId && entry.taskId !== taskId) { return false; }
                if (keyword) {
                    const hay = `${entry.message} ${entry.context || ''} ${entry.taskId || ''}`.toLowerCase();
                    return hay.includes(keyword);
                }
                return true;
            })
            .slice()
            .reverse();
    }

    /**
     * 格式化日志列表为纯文本
     * 便于用户复制或排查诊断问题
     */
    public formatLogsForExport(entries: LogEntry[] = this.getFilteredLogs()): string {
        const settings = storage.getSettings();
        return entries
            .slice()
            .reverse()
            .map(e => {
                const levelTag = getLogLevelName(e.level);
                const taskPart = e.taskId ? ` [#${e.taskId.slice(0, 6)}]` : '';
                const ctxPart = e.context ? ` | ${redactSensitive(e.context, settings.serverToken)}` : '';
                return `[${e.timestamp}] [${levelTag}]${taskPart} ${redactSensitive(
                    e.message,
                    settings.serverToken
                )}${ctxPart}`;
            })
            .join('\n');
    }

    public formatEntryTime(entry: LogEntry): string {
        return formatRelativeDate(entry.timestamp);
    }

    public clearLogs(): void {
        storage.setLogs([]);
    }
}

export const logger = new LoggerService();
