package com.longfloat.autofill;

/**
 * Successful body of {@code POST /fill}.
 *
 * <p>JSON shape:
 * <pre>
 * { "text": "...whatever the CLI printed...", "elapsedMs": 4213 }
 * </pre>
 *
 * @param text      raw stdout of the Claude CLI, trimmed. The extension is
 *                  responsible for parsing it (usually as JSON).
 * @param elapsedMs how long the whole call took, useful for the popup UI.
 */
public record FillResponse(String text, long elapsedMs) {
}
