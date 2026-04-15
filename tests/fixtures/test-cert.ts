// SPDX-License-Identifier: GPL-3.0-or-later
// Self-signed RSA-2048 test certificate, generated once with OpenSSL 3.2.4
// for use in unit tests and the local mock KSeF server.
//
// Generation commands (for reference / regeneration):
//
//   MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 \
//     -keyout key.pem -out cert.pem -days 3650 -nodes \
//     -subj "/CN=ksef-bridge-test/O=test"
//   openssl x509 -in cert.pem -outform DER | base64 -w 0    # → TEST_CERT_DER_BASE64
//   openssl x509 -in cert.pem -pubkey -noout | \
//     openssl rsa -pubin -outform DER | base64 -w 0           # → TEST_SPKI_DER_BASE64
//   openssl pkcs8 -in key.pem -topk8 -nocrypt -outform DER | \
//     base64 -w 0                                              # → TEST_PRIVATE_KEY_PKCS8_DER_BASE64
//
// The cert is self-signed, valid for 10 years from generation, and has zero
// security significance — it's only used to test our ASN.1 parser, RSA-OAEP
// envelope encryption, and the mock server's decryption path.

export const TEST_CERT_DER_BASE64 =
  "MIIDNTCCAh2gAwIBAgIUX+LpxKYEMI60eqYlARblUqzkMLQwDQYJKoZIhvcNAQELBQAwKjEZMBcGA1UEAwwQa3NlZi1icmlkZ2UtdGVzdDENMAsGA1UECgwEdGVzdDAeFw0yNjA0MTExODUyNDhaFw0zNjA0MDgxODUyNDhaMCoxGTAXBgNVBAMMEGtzZWYtYnJpZGdlLXRlc3QxDTALBgNVBAoMBHRlc3QwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEKAoIBAQCk+/qRymYruZ6DL1ExUugpAyKzarbsprobG6V6qpbX+vpMYOk/sUn5yxYBBTLETklY4bIOqdit/KK/RT9FnWHtXSDBXeY/0XYrX7EYzKzat/ipw14u9TZgkUC7qSsxcU90EzuhHCn3QWLUKmNlXsgiWT52i3zb8+HGDQ/Qr/E9CBPvnJQM1Gwf4R+419tfg4ICPe13B1fx4h3d/JC2MhqftklzJAw8LME+TTsaHG/h0RxxGbfr1FQtdXfpKsStM/4Z5v0mP/dd1vQrg25DYctp91jm24JxbtKkRYSrgYhmPng47cizG+y7dMaYfc7Zk6l+S4sA/E2v609B13f66uepAgMBAAGjUzBRMB0GA1UdDgQWBBTuW4CK6yYFH5JwDjYHfQj1SQOknzAfBgNVHSMEGDAWgBTuW4CK6yYFH5JwDjYHfQj1SQOknzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQAYel5mkinRheV5ZbiRn5dFjaouQ+rcIIESmTZjiXiYMwoF4Rq0I5z7SmBJZBYvpIdR3hj7APttrOJyaxOfbq3+F3ARkjLT/IJpOEqwE76yeHF3iOLYRO38tfPMOX86fVIOdxiqOXJsgzgKGKkH5wxfjJ0oQupae9uOQxXkmb7JNyLu0FARzgtZDBll7X29nlc1u8LVoUAjtt+92YM9jkgf8jPjTCUZLdEer6NGkAX5860WNNmuaEPqDz0CkykM3sgR0I9LyWX8M1kUL7kj3sd9hSFzt7JaC3stRJ+bH/RBLGlyk7yVkQ4LPiClMWlVbGtAseiSMob1qS9tmsnZOTR8";

export const TEST_SPKI_DER_BASE64 =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEApPv6kcpmK7megy9RMVLoKQMis2q27Ka6GxuleqqW1/r6TGDpP7FJ+csWAQUyxE5JWOGyDqnYrfyiv0U/RZ1h7V0gwV3mP9F2K1+xGMys2rf4qcNeLvU2YJFAu6krMXFPdBM7oRwp90Fi1CpjZV7IIlk+dot82/Phxg0P0K/xPQgT75yUDNRsH+EfuNfbX4OCAj3tdwdX8eId3fyQtjIan7ZJcyQMPCzBPk07Ghxv4dEccRm369RULXV36SrErTP+Geb9Jj/3Xdb0K4NuQ2HLafdY5tuCcW7SpEWEq4GIZj54OO3Isxvsu3TGmH3O2ZOpfkuLAPxNr+tPQdd3+urnqQIDAQAB";

export const TEST_PRIVATE_KEY_PKCS8_DER_BASE64 =
  "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCk+/qRymYruZ6DL1ExUugpAyKzarbsprobG6V6qpbX+vpMYOk/sUn5yxYBBTLETklY4bIOqdit/KK/RT9FnWHtXSDBXeY/0XYrX7EYzKzat/ipw14u9TZgkUC7qSsxcU90EzuhHCn3QWLUKmNlXsgiWT52i3zb8+HGDQ/Qr/E9CBPvnJQM1Gwf4R+419tfg4ICPe13B1fx4h3d/JC2MhqftklzJAw8LME+TTsaHG/h0RxxGbfr1FQtdXfpKsStM/4Z5v0mP/dd1vQrg25DYctp91jm24JxbtKkRYSrgYhmPng47cizG+y7dMaYfc7Zk6l+S4sA/E2v609B13f66uepAgMBAAECggEACrqHFBF3HOtMa0f5re0wAzC8wjGTlSaPbiFZXLV4qzFbMvnPWTC4eIm0E9tobnsPynucxlbVrBTEaY9Bes+t9U9LyL9IMIi4uD/YBp6StANoJHP7rS6Ne3CepsVstWGiss/oXgT0lqtWF6ls/sPP3Gn0xaUy+KOuoCAr0dyLIbaIuXXqpKIJRJZxbHRHqyNqNE9Tz4TfIbokgHCRPKwri/8g/PZubq3I0wkyVxDgurR/Sd3RIyiq7WVVAQgw3LUiggJtQOFCR9WQeJzlm94tu+ETqCzmKp60tR4f+8mL8WV3XV5EGw9yMXhJWZ5m3N8kwrM2WX4K7Ns8m5E+hRMHDQKBgQDbu7dFR0qU0RXDfx+E8tAL+ZgvwPKAECXHAfU7AgzeJPoh73PFfCwuRrgBdzpSxQqiplsEZRbJkRvzdDLI+9iRz4qKuKHtl4EhHY/1uEbuR99X9BjeNBWQ1maclR+Nq8j//IqUD/nsms5du0AfcpI2mnW+0FkeqItfwsZTYBIhZQKBgQDANvsXceVz2xLIKTgFuf119dBWgazTCk+dgs6DgdAikIeQjhID6pfjZUSepFOr/0Cv3MoVi7UzoG8O6NxMMRCA9ew4zarSwsFj2xC57Yauk3iEi3fKL+5MlQpQx0E2fFKdJLKHUWP4p2qi9PQC6YVK9A4zGzbWu62EX+o6WIcK9QKBgCPzw9nW/1H4H+p7y0lyfS3oackudb8UZUn5fQlpnXdfb3nL9xJR7dyof4Tl4CoYyVOximTesWrLjlo4IfMWmenJnm5yJTR9vIgRkTNwMlLceaOnccYxmXG4UtO95orEl7+ir33oW0kmTyuw7p32ngvHHArbhilpBFznvpF3v5+tAoGAY9tsYMaz/JdgT4pSZ28zhRe6L2bY4R6nM94j6WAEQCCzvN6B73TtiZ4vovcd3OoTsglTFxRog7SiXa2N3StUNpsMKIp4Z1v0WisRqnYClSlZ4AoQpoJ2G2UGYebSMzstNCQ/d1tKQ4C+PoBhUC3/KGxYACbwO2hvAalOpxccuQ0CgYEAr0F21jWSSkXCBJPiTo+LfYpv6bzzR94WSNGXELhlcmqBm4uGCam3aPmtT05ZwuWHB1/o1yqRD01sxqQsbxMdP7JovSUJ0gq9EupH6MRheEtKyuiypKyk6Ws4t5suStgeZT386EcwbksTenhgc/f9J63up0j00bVlh+ekfvKIcGc=";
