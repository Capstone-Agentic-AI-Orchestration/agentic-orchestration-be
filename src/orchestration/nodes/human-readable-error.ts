export function humanReadableError(message: string): string {
  if (message.includes('timeout') || message.includes('timed out')) {
    return 'The AI model took too long to respond. This may be due to high demand or a temporary network issue.';
  }
  if (message.includes('rate limit') || message.includes('429')) {
    return 'Too many requests sent to the AI model. Waiting a moment before retrying...';
  }
  if (message.includes('unauthorized') || message.includes('401') || message.includes('403')) {
    return 'Authentication failed. Please check your LLM provider API key configuration.';
  }
  if (message.includes('empty response')) {
    return 'The AI model returned an empty response. This is unusual — retrying with a fresh request.';
  }
  return message.length > 300 ? message.slice(0, 300) + '...' : message;
}
