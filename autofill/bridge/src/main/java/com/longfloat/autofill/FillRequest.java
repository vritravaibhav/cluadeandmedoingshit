package com.longfloat.autofill;

import jakarta.validation.constraints.NotBlank;

/**
 * Body of {@code POST /fill}.
 *
 * <p>JSON shape:
 * <pre>
 * { "prompt": "You are filling a job application form ..." }
 * </pre>
 *
 * @param prompt the full prompt to hand to the Claude CLI. Rejected when null,
 *               empty or whitespace only - see {@link GlobalExceptionHandler}.
 */
public record FillRequest(

        @NotBlank(message = "prompt must not be blank")
        String prompt

) {
}
