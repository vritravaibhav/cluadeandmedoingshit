package com.longfloat.autofill;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.ThreadFactory;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Runs the local Claude Code CLI in headless mode and returns what it printed.
 *
 * <p>This is the only class in the bridge that touches the operating system, so
 * all of the process handling care lives here.
 */
@Service
public class ClaudeCliService {

    private static final Logger log = LoggerFactory.getLogger(ClaudeCliService.class);

    /**
     * Absolute path to the CLI executable.
     *
     * <p>ProcessBuilder does NOT use a shell, so it does not see PATH entries added
     * by ~/.zshrc. Always configure the full path (run {@code which claude}).
     */
    private final String binaryPath;

    /** Hard wall clock limit for one invocation. */
    private final long timeoutSeconds;

    /**
     * Smallest amount of time we are willing to spend draining the pipes after
     * the child has exited. Without a floor, a CLI that finished a hair before
     * the deadline would leave a couple of milliseconds for the drain and fail
     * a request that actually succeeded.
     */
    private static final long MIN_DRAIN_MILLIS = 2_000L;

    /**
     * How long to wait for the stderr reader after force killing the child, so
     * the timeout log line can actually contain the CLI's last words instead of
     * an empty string.
     */
    private static final long STDERR_GRACE_MILLIS = 500L;

    /**
     * Threads used only to drain the child process' stdout and stderr.
     *
     * <p>Cached pool: two short lived threads per request, reused between requests.
     * The threads are daemons so they can never keep the JVM alive on shutdown.
     */
    private final ExecutorService streamReaders;

    public ClaudeCliService(
            @Value("${claude.binary-path:/usr/local/bin/claude}") String binaryPath,
            @Value("${claude.timeout-seconds:120}") long timeoutSeconds) {

        this.binaryPath = binaryPath;
        this.timeoutSeconds = timeoutSeconds;
        this.streamReaders = Executors.newCachedThreadPool(daemonThreadFactory());

        log.info("Claude CLI bridge configured: binary={}, timeout={}s, binaryExists={}",
                binaryPath, timeoutSeconds, isBinaryPresent());
    }

    /** Path the bridge will execute. Exposed for the /health endpoint. */
    public String getBinaryPath() {
        return binaryPath;
    }

    /**
     * True when the configured path points at a real, executable file.
     * Exposed for the /health endpoint so a wrong path is obvious immediately
     * instead of only failing on the first /fill call.
     */
    public boolean isBinaryPresent() {
        try {
            Path path = Paths.get(binaryPath);
            return Files.isRegularFile(path) && Files.isExecutable(path);
        } catch (RuntimeException ex) {
            // An invalid path string (illegal characters, etc.) simply means "not there".
            return false;
        }
    }

    /**
     * Sends one prompt to the CLI and returns its stdout.
     *
     * @param prompt the full prompt text, already assembled by the caller
     * @return whatever the CLI wrote to stdout, trimmed
     * @throws ClaudeTimeoutException   when the CLI outran {@code claude.timeout-seconds}
     * @throws ClaudeExecutionException when the CLI could not start or exited non zero
     */
    public String run(String prompt) {
        long startedAtNanos = System.nanoTime();

        // -p is Claude Code's headless / print mode: run once, print the answer, exit.
        ProcessBuilder processBuilder = new ProcessBuilder(binaryPath, "-p", prompt);

        // Deliberately NOT calling redirectErrorStream(true).
        //
        // Merging stderr into stdout would mean an authentication failure, a quota
        // warning or a stack trace ends up mixed into the answer text, and the
        // extension would happily paste that noise into the job application form.
        // Keeping the two streams apart lets us treat stderr strictly as diagnostics.

        Process process;
        try {
            process = processBuilder.start();
        } catch (IOException ex) {
            // Almost always a wrong claude.binary-path.
            throw new ClaudeExecutionException(
                    "Could not start the Claude CLI at '" + binaryPath
                            + "'. Run 'which claude' and put the result in claude.binary-path.",
                    -1,
                    ex.getMessage(),
                    ex);
        }

        // The CLI gets its prompt from the -p argument, so it needs nothing on stdin.
        // Closing the pipe immediately gives the child an EOF; otherwise a CLI that
        // decides to read stdin would sit there waiting forever.
        closeQuietly(process.getOutputStream());

        // ------------------------------------------------------------------
        // Drain stdout and stderr CONCURRENTLY, before waitFor().
        //
        // Why this matters: the OS gives each pipe a small fixed buffer (~64 KB on
        // Linux and macOS). If we read stdout to completion first and the child
        // meanwhile fills the stderr buffer, the child blocks on its stderr write
        // and stops producing stdout. We then block reading stdout that will never
        // arrive, and the child blocks writing stderr nobody is reading: a classic
        // deadlock, and waitFor() never returns.
        //
        // The same deadlock happens in reverse if stderr is read first and stdout
        // overflows. Reading both streams on separate threads is the only safe
        // ordering, and it must happen BEFORE waitFor() for the same reason.
        // ------------------------------------------------------------------
        CompletableFuture<String> stdoutFuture =
                CompletableFuture.supplyAsync(() -> readAll(process.getInputStream()), streamReaders);
        CompletableFuture<String> stderrFuture =
                CompletableFuture.supplyAsync(() -> readAll(process.getErrorStream()), streamReaders);

        boolean finishedInTime;
        try {
            finishedInTime = process.waitFor(timeoutSeconds, TimeUnit.SECONDS);
        } catch (InterruptedException ex) {
            // Someone interrupted the request thread (shutdown, client aborted).
            // Restore the flag - swallowing it would hide the shutdown from callers.
            Thread.currentThread().interrupt();
            killProcessTree(process);
            throw new ClaudeExecutionException(
                    "Interrupted while waiting for the Claude CLI.",
                    -1,
                    waitBrieflyForStderr(stderrFuture),
                    ex);
        }

        if (!finishedInTime) {
            // destroy() sends SIGTERM which the CLI may ignore; destroyForcibly()
            // is SIGKILL and always wins. killProcessTree also takes the CLI's
            // children with it - see that method for why that matters.
            killProcessTree(process);

            // Give the stderr reader a moment to come back with what it saw.
            // Without this pause the log line below printed nothing after the
            // colon, every single time: waitFor only expires while the child is
            // still ALIVE, so its stderr pipe was still open and the reader was
            // still blocked when we asked. And that log is the only place the
            // CLI's own explanation ("not logged in", "quota exceeded") ever
            // surfaces, since the 504 body carries no stderr.
            String stderrSoFar = waitBrieflyForStderr(stderrFuture);

            long elapsedMs = elapsedMillis(startedAtNanos);
            log.error("Claude CLI timed out after {} ms (limit {}s). stderr so far: {}",
                    elapsedMs, timeoutSeconds, stderrSoFar.isBlank() ? "(none)" : stderrSoFar.strip());

            throw new ClaudeTimeoutException(
                    "The Claude CLI did not answer within " + timeoutSeconds + " seconds."
                            + (stderrSoFar.isBlank() ? "" : " It last said: " + stderrSoFar.strip()),
                    timeoutSeconds);
        }

        // ------------------------------------------------------------------
        // Drain the pipes, but NEVER without a deadline.
        //
        // It is tempting to write stdoutFuture.join() here and justify it with
        // "the process has exited, so the pipes are at EOF". That is only true
        // for the DIRECT child. `claude` is a Node CLI that spawns subprocesses
        // (tool runners, MCP servers), and a grandchild inherits the very same
        // pipe write ends. If any descendant outlives its parent, EOF never
        // arrives, readAllBytes() blocks forever, and this Tomcat worker thread
        // is pinned for good - so claude.timeout-seconds would stop being an
        // upper bound on the request at all.
        //
        // Budget: whatever is left of the configured timeout, with a floor.
        // ------------------------------------------------------------------
        long remainingMs = Math.max(
                MIN_DRAIN_MILLIS,
                timeoutSeconds * 1000L - elapsedMillis(startedAtNanos));

        String stdout;
        String stderr;
        try {
            stdout = stdoutFuture.get(remainingMs, TimeUnit.MILLISECONDS);
            stderr = stderrFuture.get(remainingMs, TimeUnit.MILLISECONDS);
        } catch (TimeoutException ex) {
            // The child is gone but something it left behind is still holding
            // the pipe open. Best effort tidy up: the orphan has already been
            // re-parented to launchd by now, so descendants() will usually find
            // nothing and the reader thread may sit there until the orphan
            // exits. It is a daemon thread, so it cannot keep the JVM alive -
            // and the point of this branch is that the REQUEST thread is freed
            // and the caller gets an answer instead of hanging forever.
            killProcessTree(process);
            stdoutFuture.cancel(true);
            stderrFuture.cancel(true);

            log.error("The Claude CLI exited but its output pipes stayed open for {} ms"
                    + " - a leftover child process is probably still holding them.", remainingMs);

            throw new ClaudeTimeoutException(
                    "The Claude CLI exited but its output never finished arriving."
                            + " A leftover child process was still holding the pipe open.",
                    timeoutSeconds);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            killProcessTree(process);
            throw new ClaudeExecutionException(
                    "Interrupted while reading the Claude CLI's output.", -1, "", ex);
        } catch (ExecutionException ex) {
            // readAll() catches its own IOExceptions, so this really should not
            // happen; handled anyway so a surprise cannot become a 500.
            throw new ClaudeExecutionException(
                    "Failed to read the Claude CLI's output.", -1, "", ex);
        }

        int exitCode = process.exitValue();
        long elapsedMs = elapsedMillis(startedAtNanos);

        log.info("Claude CLI finished: exitCode={}, elapsedMs={}, stdoutChars={}",
                exitCode, elapsedMs, stdout.length());

        if (!stderr.isBlank()) {
            // Even on success the CLI may warn about something worth seeing.
            log.error("Claude CLI stderr: {}", stderr.strip());
        }

        if (exitCode != 0) {
            throw new ClaudeExecutionException(
                    "The Claude CLI exited with code " + exitCode + ".",
                    exitCode,
                    stderr.strip());
        }

        return stdout.strip();
    }

    /** Reads a whole process stream into a UTF-8 string. Runs on a reader thread. */
    private static String readAll(java.io.InputStream stream) {
        try (java.io.InputStream in = stream) {
            return new String(in.readAllBytes(), StandardCharsets.UTF_8);
        } catch (IOException ex) {
            // Happens when the process was force killed mid write. Not fatal:
            // whatever we managed to see is gone, and the caller is already
            // throwing a timeout / execution exception.
            log.debug("Failed to drain a Claude CLI stream: {}", ex.getMessage());
            return "";
        }
    }

    /**
     * Force kills the CLI <em>and everything it started</em>.
     *
     * <p>{@code process.destroyForcibly()} sends SIGKILL to the one child PID we
     * hold. ProcessBuilder does not put the child in its own process group, so
     * anything that child spawned - Node workers, MCP servers, tool subagents -
     * is not in the signal's scope. Those survivors get re-parented to launchd
     * and keep running, holding CPU, memory, and (the part that bites us) the
     * stdout/stderr pipe write ends they inherited, which is exactly what stops
     * our reader threads from ever seeing EOF.
     *
     * <p>The descendants have to be collected BEFORE the parent dies: once it is
     * gone they are no longer its descendants and the walk finds nothing.
     */
    private static void killProcessTree(Process process) {
        List<ProcessHandle> descendants = List.of();
        try {
            descendants = process.descendants().toList();
        } catch (RuntimeException ex) {
            log.debug("Could not enumerate the Claude CLI's child processes: {}", ex.getMessage());
        }

        process.destroyForcibly();

        for (ProcessHandle child : descendants) {
            try {
                child.destroyForcibly();
            } catch (RuntimeException ex) {
                log.debug("Could not kill child process {}: {}", child.pid(), ex.getMessage());
            }
        }
    }

    /**
     * Best effort read of whatever the CLI wrote to stderr, waiting only a
     * moment for it. Used on the failure paths, where the process has just been
     * killed and the reader thread needs a beat to notice the pipe closing.
     *
     * <p>Never throws: this only ever feeds a log line or an error message, and
     * failing to produce diagnostics must not replace the real failure.
     */
    private static String waitBrieflyForStderr(CompletableFuture<String> stderrFuture) {
        try {
            return stderrFuture.get(STDERR_GRACE_MILLIS, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return "";
        } catch (TimeoutException | ExecutionException ex) {
            // Still blocked, or the reader itself blew up. Either way we have
            // nothing to show; the real failure is reported by the caller.
            return "";
        }
    }

    private static void closeQuietly(OutputStream stream) {
        try {
            stream.close();
        } catch (IOException ex) {
            log.debug("Could not close the child stdin pipe: {}", ex.getMessage());
        }
    }

    private static long elapsedMillis(long startedAtNanos) {
        return (System.nanoTime() - startedAtNanos) / 1_000_000L;
    }

    private static ThreadFactory daemonThreadFactory() {
        AtomicInteger counter = new AtomicInteger(1);
        return runnable -> {
            Thread thread = new Thread(runnable, "claude-stream-" + counter.getAndIncrement());
            thread.setDaemon(true);
            return thread;
        };
    }

    /** Releases the reader threads when the Spring context shuts down. */
    @PreDestroy
    void shutdown() {
        streamReaders.shutdownNow();
    }
}
