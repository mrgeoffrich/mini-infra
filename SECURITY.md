# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| latest  | :white_check_mark: |

## Reporting a Vulnerability

If you discover a security vulnerability in Mini Infra, please report it responsibly.

**Please do NOT open a public GitHub issue for security vulnerabilities.**

Instead, please email: **geoff.rich@gmail.com**

Include the following in your report:

- A description of the vulnerability
- Steps to reproduce the issue
- Any potential impact
- Suggested fix (if you have one)

## Response Timeline

- **Acknowledgment**: Within 48 hours
- **Initial assessment**: Within 1 week
- **Fix or mitigation**: Depends on severity, but we aim for prompt resolution

## Scope

This policy applies to the latest version of Mini Infra running as intended. The following are generally out of scope:

- Vulnerabilities in dependencies that are already publicly disclosed (please check existing issues first)
- Issues that require physical access to the host machine
- Default development credentials (e.g., HAProxy `admin:admin`) that are clearly documented as needing to be changed in production

## Security Best Practices for Deployment

When deploying Mini Infra in production:

1. **Change all default credentials** — especially HAProxy stats and Data Plane API passwords
2. **Generate strong secrets** for `SESSION_SECRET`, `API_KEY_SECRET`, and `ENCRYPTION_SECRET`
3. **Restrict Docker socket access** — the mounted Docker socket gives full control of the host Docker daemon
4. **Use HTTPS** — deploy behind a reverse proxy with TLS termination
5. **Set `ALLOWED_ADMIN_EMAILS`** — restrict who can authenticate via Google OAuth
6. **Keep dependencies updated** — run `npm audit` regularly

Thank you for helping keep Mini Infra secure.
