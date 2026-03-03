# Public Release Plan

## Tasks

| # | Task | Priority |
|---|------|----------|
| 1 | **Add `ALLOWED_ADMIN_EMAILS` env var** — Modify passport.ts to check incoming Google email against a comma-separated allowlist. Reject login if not on the list. Add to `.env.example`. | Critical |
| 2 | **Remove `postgres-config.json` from tracking** — Delete it, add to `.gitignore`. | Critical |
| 3 | **Sanitize `deployment/production/docker-compose.yaml`** — Replace hardcoded email/password with `${ENV_VAR}` references. | Critical |
| 4 | **Add `*.db` to `.gitignore`** — Currently only WAL/SHM are excluded. | High |
| 5 | **Audit `projectmanagement/` folder** — Contains references to `pilltracker.app` and personal domain names. Decide if you want this in the public repo or gitignored. | Medium |
| 6 | **Add MIT LICENSE file** | High |
| 7 | **Review/update README.md** — Make it suitable for a public audience (setup instructions, contribution guidelines). | Medium |
| 8 | **Review `package.json` `"private": true`** — Keep if not publishing to npm (likely keep). | Low |
| 9 | **Rotate all exposed credentials** — The postgres password, Google OAuth client secret, and LangSmith key from `.env` have been in your working directory. Rotate them after going public. | Critical |
| 10 | **Squash history and force-push** — Create an orphan branch as the new `main` with a clean initial commit. | Final step |
