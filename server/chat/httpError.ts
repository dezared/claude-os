// An error with an HTTP status, thrown by the chat and read by the server's error handler.
// `key` and `params` reach the UI, which shows its own text for them: errors.<key> in the web catalogs.
export class HttpError extends Error {
  statusCode: number;
  key?: string;
  params?: Record<string, string | number>;
  constructor(statusCode: number, message: string, key?: string, params?: Record<string, string | number>) {
    super(message);
    this.statusCode = statusCode;
    this.key = key;
    this.params = params;
  }
}
