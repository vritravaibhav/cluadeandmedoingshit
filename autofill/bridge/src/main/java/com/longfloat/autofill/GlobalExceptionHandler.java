package com.longfloat.autofill;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.validation.FieldError;
import org.springframework.web.HttpMediaTypeNotSupportedException;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.util.stream.Collectors;

/**
 * Turns every exception thrown by the controller or the service into a small
 * {@link ErrorResponse} JSON body with a meaningful HTTP status.
 *
 * <p>Without this the extension would receive Spring's default HTML/JSON error
 * page and could only say "something went wrong".
 */
@RestControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(GlobalExceptionHandler.class);

    /**
     * The CLI outran its timeout. 504 is the honest status: we are a gateway in
     * front of the CLI and the upstream did not answer in time.
     */
    @ExceptionHandler(ClaudeTimeoutException.class)
    public ResponseEntity<ErrorResponse> handleTimeout(ClaudeTimeoutException ex) {
        log.error("Returning 504: {}", ex.getMessage());
        return ResponseEntity
                .status(HttpStatus.GATEWAY_TIMEOUT)
                .body(new ErrorResponse("CLAUDE_TIMEOUT", ex.getMessage()));
    }

    /**
     * The CLI could not be started, or exited non zero. 502 again reflects the
     * gateway role: the upstream gave us an invalid response.
     *
     * <p>The CLI's stderr is appended to the detail because that is where the
     * useful text lives ("not logged in", "command not found", quota messages).
     */
    @ExceptionHandler(ClaudeExecutionException.class)
    public ResponseEntity<ErrorResponse> handleExecution(ClaudeExecutionException ex) {
        String detail = ex.getStderr().isBlank()
                ? ex.getMessage()
                : ex.getMessage() + " " + ex.getStderr();

        log.error("Returning 502: exitCode={}, message={}, stderr={}",
                ex.getExitCode(), ex.getMessage(), ex.getStderr());

        return ResponseEntity
                .status(HttpStatus.BAD_GATEWAY)
                .body(new ErrorResponse("CLAUDE_FAILED", detail));
    }

    /**
     * Bean validation on the request body failed, e.g. a blank prompt.
     * That is the caller's mistake, so 400.
     */
    @ExceptionHandler(MethodArgumentNotValidException.class)
    public ResponseEntity<ErrorResponse> handleValidation(MethodArgumentNotValidException ex) {
        // Collapse all field errors into one readable sentence.
        String detail = ex.getBindingResult().getFieldErrors().stream()
                .map(GlobalExceptionHandler::describeFieldError)
                .collect(Collectors.joining("; "));

        if (detail.isBlank()) {
            detail = "The request body is invalid.";
        }

        log.warn("Returning 400: {}", detail);

        return ResponseEntity
                .status(HttpStatus.BAD_REQUEST)
                .body(new ErrorResponse("VALIDATION_FAILED", detail));
    }

    /**
     * Spring MVC's own request-level failures.
     *
     * <p>WHY THESE THREE NEED THEIR OWN HANDLERS: an {@code @ExceptionHandler}
     * for {@code Exception.class} in a {@code @RestControllerAdvice} is consulted
     * BEFORE Spring's built-in DefaultHandlerExceptionResolver, so without these
     * methods the catch-all below swallowed the framework's exceptions too and
     * reported every one of them as 500 INTERNAL_ERROR - a browser GET on /fill
     * answered "the bridge crashed" when the truth was "wrong HTTP method", and
     * a malformed request body said the same when the truth was "your JSON is
     * broken". That defeats the entire point of this class, which is to give the
     * extension an honest status it can act on.
     *
     * <p>One small method each, all returning the same {@link ErrorResponse}
     * shape the extension already knows how to read; only the status differs.
     *
     * <p>Not listed here: a request for a URL that does not exist. Spring routes
     * that one to a different resolver which this advice never sees, so a
     * mistyped bridge URL still answers 404 by itself.
     */
    @ExceptionHandler(HttpRequestMethodNotSupportedException.class)
    public ResponseEntity<ErrorResponse> handleWrongMethod(HttpRequestMethodNotSupportedException ex) {
        log.warn("Returning 405: {}", ex.getMessage());
        return ResponseEntity
                .status(HttpStatus.METHOD_NOT_ALLOWED)
                .body(new ErrorResponse("METHOD_NOT_ALLOWED", ex.getMessage()));
    }

    /** Wrong or missing Content-Type on /fill. */
    @ExceptionHandler(HttpMediaTypeNotSupportedException.class)
    public ResponseEntity<ErrorResponse> handleWrongMediaType(HttpMediaTypeNotSupportedException ex) {
        log.warn("Returning 415: {}", ex.getMessage());
        return ResponseEntity
                .status(HttpStatus.UNSUPPORTED_MEDIA_TYPE)
                .body(new ErrorResponse("UNSUPPORTED_MEDIA_TYPE",
                        ex.getMessage() + " Send Content-Type: application/json."));
    }

    /** The body was not readable as JSON at all (truncated, wrong quoting, ...). */
    @ExceptionHandler(HttpMessageNotReadableException.class)
    public ResponseEntity<ErrorResponse> handleUnreadableBody(HttpMessageNotReadableException ex) {
        log.warn("Returning 400: unreadable request body: {}", ex.getMessage());
        return ResponseEntity
                .status(HttpStatus.BAD_REQUEST)
                .body(new ErrorResponse("MALFORMED_JSON",
                        "The request body could not be read as JSON."));
    }

    /** Anything we did not anticipate. Logged with the stack trace, reported as 500. */
    @ExceptionHandler(Exception.class)
    public ResponseEntity<ErrorResponse> handleAnythingElse(Exception ex) {
        log.error("Returning 500: unexpected failure in the autofill bridge", ex);
        return ResponseEntity
                .status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new ErrorResponse("INTERNAL_ERROR",
                        ex.getClass().getSimpleName() + ": " + ex.getMessage()));
    }

    private static String describeFieldError(FieldError fieldError) {
        return fieldError.getField() + ": " + fieldError.getDefaultMessage();
    }
}
