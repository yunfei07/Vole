import { z } from 'zod';

export const logLevelSchema = z.enum(['debug', 'info', 'warn', 'error']);

export const loggingConfigSchema = z.object({
  enabled: z.boolean().default(true),
  level: logLevelSchema.default('info'),
  directory: z.string().min(1).default('.vole/logs'),
  retentionDays: z.number().int().positive().default(30),
  maxFileSizeMb: z.number().positive().default(20)
});

export type LogLevel = z.infer<typeof logLevelSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;

export const defaultLoggingConfig: LoggingConfig = {
  enabled: true,
  level: 'info',
  directory: '.vole/logs',
  retentionDays: 30,
  maxFileSizeMb: 20
};
