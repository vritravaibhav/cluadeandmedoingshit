package com.longfloat.autofill;

import jakarta.validation.Valid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.MediaType;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * The bridge's whole HTTP surface: two endpoints.
 *
 * <p>CORS is required because the caller is a Chrome extension. Its requests
 * carry an origin of {@code chrome-extension://<extension-id>}, which is a
 * different origin from {@code http://127.0.0.1:3111}. Declaring it here also
 * makes Spring answer the browser's automatic OPTIONS preflight for us - there
 * is no need to write an OPTIONS handler by hand.
 *
 * <p><b>Why a pattern and not {@code origins = "*"}.</b> CORS is enforced by
 * the browser, not by us, so a wildcard means any ordinary web page the user
 * happens to be visiting may POST to {@code http://127.0.0.1:3111/fill} and
 * read the answer - an unauthenticated command surface backed by the user's
 * own Claude subscription. {@code chrome-extension://*} still matches this
 * extension (its id changes between an unpacked load and a store install, so
 * it cannot be hard coded) while refusing every http/https page.
 *
 * <p>The second half of the protection is in application.properties:
 * {@code server.address=127.0.0.1} keeps the listener on the loopback
 * interface, so nothing on the local network can reach it either. There is no
 * authentication on {@code /fill}; those two lines are what stands in for it.
 */
@RestController
@CrossOrigin(originPatterns = "chrome-extension://*")
public class ClaudeBridgeController {

    private static final Logger log = LoggerFactory.getLogger(ClaudeBridgeController.class);

    private final ClaudeCliService claudeCliService;

    // Constructor injection: single constructor, so no @Autowired needed.
    public ClaudeBridgeController(ClaudeCliService claudeCliService) {
        this.claudeCliService = claudeCliService;
    }

    /**
     * Forwards one prompt to the Claude CLI.
     *
     * <p>Failures are not handled here on purpose - the exceptions thrown by
     * {@link ClaudeCliService} bubble up to {@link GlobalExceptionHandler},
     * which turns them into 504 / 502 / 400 / 500 with a real message.
     */
    @PostMapping(
            path = "/fill",
            consumes = MediaType.APPLICATION_JSON_VALUE,
            produces = MediaType.APPLICATION_JSON_VALUE)
    public FillResponse fill(@Valid @RequestBody FillRequest request) {

        log.info("POST /fill received, promptChars={}", request.prompt().length());

        long startedAtNanos = System.nanoTime();
        String text = claudeCliService.run(request.prompt());
        long elapsedMs = (System.nanoTime() - startedAtNanos) / 1_000_000L;

        return new FillResponse(text, elapsedMs);
    }

    /**
     * Cheap liveness probe for the extension's status dot.
     *
     * <p>It never shells out - it only reports the configured binary path and
     * whether that path actually exists, which is by far the most common
     * misconfiguration.
     */
    @GetMapping(path = "/health", produces = MediaType.APPLICATION_JSON_VALUE)
    public HealthResponse health() {
        boolean binaryExists = claudeCliService.isBinaryPresent();
        String status = binaryExists ? "UP" : "DEGRADED";
        return new HealthResponse(status, claudeCliService.getBinaryPath(), binaryExists);
    }
}
