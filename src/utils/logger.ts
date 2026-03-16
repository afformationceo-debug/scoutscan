import winston from 'winston';
import TransportStream from 'winston-transport';

const { combine, timestamp, printf, colorize } = winston.format;

const logFormat = printf(({ level, message, timestamp, ...meta }) => {
  const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
  return `${timestamp} [${level}] ${message}${metaStr}`;
});

// In-memory log buffer for API access
const LOG_BUFFER_SIZE = 200;
const logBuffer: string[] = [];

export function getRecentLogs(filter?: string): string[] {
  if (!filter) return [...logBuffer];
  return logBuffer.filter(l => l.toLowerCase().includes(filter.toLowerCase()));
}

class MemoryTransport extends TransportStream {
  log(info: any, callback: () => void) {
    const line = `${info.timestamp || new Date().toISOString()} [${info.level}] ${info.message}`;
    logBuffer.push(line);
    if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
    if (callback) callback();
  }
}

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    logFormat
  ),
  transports: [
    new winston.transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
    }),
    new winston.transports.File({
      filename: 'scraper.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3,
    }),
    new MemoryTransport(),
  ],
});
