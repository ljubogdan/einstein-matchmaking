// Key-shaped strings (Anthropic, Google, OpenAI). Everything we write to a file or print passes through this.
const KEY_PATTERN = /sk-ant-[\w-]{10,}|AIza[\w-]{30,}|sk-(?:proj-)?[A-Za-z0-9]{20,}/g

export const redactKeys = (text: string): string => text.replace(KEY_PATTERN, "[redacted]")
