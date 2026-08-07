package com.longfloat.autofill;

/**
 * Thrown when the Claude Code CLI did not finish inside the configured
 * timeout window. The child process has already been force killed by the
 * time this exception leaves {@link ClaudeCliService}.
 *
 * <p>Mapped to HTTP 504 GATEWAY_TIMEOUT by {@link GlobalExceptionHandler}.
 */
public class ClaudeTimeoutException extends RuntimeException {

    /** How long we actually waited before giving up, in seconds. */
    private final long timeoutSeconds;

    public ClaudeTimeoutException(String message, long timeoutSeconds) {
        super(message);
        this.timeoutSeconds = timeoutSeconds;
    }

    public long getTimeoutSeconds() {
        return timeoutSeconds;
    }
}
