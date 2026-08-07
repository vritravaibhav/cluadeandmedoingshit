package com.longfloat.autofill;

/**
 * Uniform error body for every failing endpoint, so the extension can always
 * show a real message instead of "request failed".
 *
 * <p>JSON shape:
 * <pre>
 * { "error": "CLAUDE_TIMEOUT", "detail": "The Claude CLI did not answer within 120 seconds." }
 * </pre>
 *
 * @param error  short machine readable code, e.g. CLAUDE_TIMEOUT, CLAUDE_FAILED,
 *               VALIDATION_FAILED, INTERNAL_ERROR.
 * @param detail human readable explanation, usually including the CLI's stderr.
 */
public record ErrorResponse(String error, String detail) {
}
