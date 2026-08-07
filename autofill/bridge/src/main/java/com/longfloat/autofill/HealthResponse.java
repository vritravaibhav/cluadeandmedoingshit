package com.longfloat.autofill;

/**
 * Body of {@code GET /health}. Drives the extension's status dot and lets the
 * user diagnose a wrong {@code claude.binary-path} without reading server logs.
 *
 * <p>JSON shape:
 * <pre>
 * { "status": "UP", "claudeBinary": "/usr/local/bin/claude", "binaryExists": true }
 * </pre>
 *
 * @param status       "UP" when the bridge is running and the binary is present,
 *                     "DEGRADED" when the bridge is running but the binary is missing.
 * @param claudeBinary the configured path, echoed back so the user can compare it
 *                     with the output of {@code which claude}.
 * @param binaryExists true when that path is a real executable file.
 */
public record HealthResponse(String status, String claudeBinary, boolean binaryExists) {
}
