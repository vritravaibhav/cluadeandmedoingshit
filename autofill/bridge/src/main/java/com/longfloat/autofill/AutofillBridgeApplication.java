package com.longfloat.autofill;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Entry point of the autofill bridge.
 *
 * <p>The bridge is a tiny local HTTP server. The Chrome extension POSTs a prompt
 * to it, the bridge shells out to the locally installed Claude Code CLI in
 * headless mode ({@code claude -p "<prompt>"}) and returns whatever the CLI
 * printed on stdout.
 *
 * <p>Because the CLI is used, the user's existing Claude subscription and login
 * are reused. No API key is stored anywhere in this project.
 *
 * <p>Run it with:
 * <pre>
 *     mvn spring-boot:run
 * </pre>
 */
@SpringBootApplication
public class AutofillBridgeApplication {

    public static void main(String[] args) {
        SpringApplication.run(AutofillBridgeApplication.class, args);
    }
}
