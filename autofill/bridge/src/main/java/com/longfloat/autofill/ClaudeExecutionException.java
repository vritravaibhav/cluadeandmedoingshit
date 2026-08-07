package com.longfloat.autofill;

/**
 * Thrown when the Claude Code CLI ran but failed - a non zero exit code, or the
 * binary could not be started at all (wrong path, not executable).
 *
 * <p>The CLI's stderr text is carried along so the extension can show the real
 * reason ("not logged in", "command not found", quota messages, ...) instead of
 * a generic failure.
 *
 * <p>Mapped to HTTP 502 BAD_GATEWAY by {@link GlobalExceptionHandler}.
 */
public class ClaudeExecutionException extends RuntimeException {

    /** Process exit code, or -1 when the process never started. */
    private final int exitCode;

    /** Raw stderr text produced by the CLI. Never null, may be empty. */
    private final String stderr;

    public ClaudeExecutionException(String message, int exitCode, String stderr) {
        super(message);
        this.exitCode = exitCode;
        this.stderr = stderr == null ? "" : stderr;
    }

    public ClaudeExecutionException(String message, int exitCode, String stderr, Throwable cause) {
        super(message, cause);
        this.exitCode = exitCode;
        this.stderr = stderr == null ? "" : stderr;
    }

    public int getExitCode() {
        return exitCode;
    }

    public String getStderr() {
        return stderr;
    }
}
