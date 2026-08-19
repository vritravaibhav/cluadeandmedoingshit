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

    /**
     * How long the failed invocation ran for, in milliseconds.
     *
     * <p>Carried so {@code ClaudeCliService.run} can tell a transient stumble
     * (failed in a second or two - worth one retry) from a failure that came
     * after real work or a quota refusal, where retrying only doubles the wait.
     * -1 when the process never started.
     */
    private final long elapsedMillis;

    public ClaudeExecutionException(String message, int exitCode, String stderr) {
        this(message, exitCode, stderr, -1L);
    }

    public ClaudeExecutionException(String message, int exitCode, String stderr, long elapsedMillis) {
        super(message);
        this.exitCode = exitCode;
        this.stderr = stderr == null ? "" : stderr;
        this.elapsedMillis = elapsedMillis;
    }

    public ClaudeExecutionException(String message, int exitCode, String stderr, Throwable cause) {
        super(message, cause);
        this.exitCode = exitCode;
        this.stderr = stderr == null ? "" : stderr;
        this.elapsedMillis = -1L;
    }

    public int getExitCode() {
        return exitCode;
    }

    public String getStderr() {
        return stderr;
    }

    /** Milliseconds the failed invocation ran for, or -1 if it never started. */
    public long getElapsedMillis() {
        return elapsedMillis;
    }
}
