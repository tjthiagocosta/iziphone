/**
 * An error a module raises on purpose, carrying the HTTP status the API
 * replies with. The error handler exposes its message; every other error
 * stays a 500 with the details in the log.
 */
export class HttpError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = new.target.name;
  }
}
