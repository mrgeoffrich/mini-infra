---
title: GitHub Troubleshooting
description: Common GitHub integration issues and how to resolve them.
category: GitHub
order: 4
tags:
  - github
  - troubleshooting
  - errors
  - authentication
  - packages
  - actions
---

# GitHub Troubleshooting

Common issues with the GitHub integration in Mini Infra and how to investigate them.

---

## GitHub App setup fails at redirect

**Symptom:** Clicking "Connect to GitHub" redirects to GitHub, but the process doesn't complete or returns an error.

**Likely cause:** The browser blocked the redirect, or the GitHub manifest flow encountered a permissions issue.

**What to check:**

- Ensure your browser isn't blocking pop-ups or redirects from Mini Infra.
- Check that you're signed into GitHub with an account that has permission to create GitHub Apps (account owner or organisation admin).

**Fix:** Try the setup flow again. If you're setting up for an organisation, you may need admin privileges.

---

## App created but installation not detected

**Symptom:** The GitHub connectivity page says "Needs Installation" even after you installed the app on GitHub.

**Likely cause:** The installation check hasn't detected the new installation yet.

**What to check:**

- Click **Check Installation** to force a re-check.
- On GitHub, go to Settings > Applications (or your organisation's settings) and verify the app is installed and has access to the expected repositories.

**Fix:** Click Check Installation. If it still isn't detected, verify the installation on GitHub's side. In rare cases, you may need to disconnect and reconnect.

---

## Packages tab is empty

**Symptom:** The Packages tab shows no entries, even though you have packages in GHCR.

**Likely cause:** The Package Access Token isn't configured, or the token doesn't have the `read:packages` scope.

**What to check:**

- Look at the **Package Access** section on the GitHub connectivity page. It should show "Configured" with a green badge.
- If it says "Not Configured", you need to create and enter a Personal Access Token.
- If configured but still empty, the token may have been revoked on GitHub.

**Fix:** Generate a new PAT on GitHub with the `read:packages` scope and enter it in the Package Access section. Private packages only appear when the token has the correct scope.

---

## Repositories tab is empty or missing repos

**Symptom:** The Repositories tab shows no repos, or specific repos you expect to see are missing.

**Likely cause:** The GitHub App installation doesn't have access to the repositories.

**What to check:**

- On GitHub, go to your GitHub App installation settings and check which repositories the app can access.
- If you selected "Only select repositories" during installation, the missing repos weren't included.

**Fix:** Update the GitHub App installation on GitHub to include additional repositories, or switch to "All repositories" access.

---

## Actions tab shows no workflow runs

**Symptom:** You select a repository from the dropdown but no workflow runs appear.

**Likely cause:** The repository has no GitHub Actions workflows defined, or no runs have executed recently.

**What to check:**

- Verify the repository has workflow files in the `.github/workflows/` directory.
- Check GitHub directly to see if there are recent runs.
- Make sure the GitHub App has Actions (read) permission.

**Fix:** If workflows exist and have run on GitHub but don't appear in Mini Infra, try the **Test Connection** button to verify API access. If the test passes, the data should appear on the next refresh.

---

## GHCR image pull fails during deployment

**Symptom:** A deployment fails at the image pull step when using a `ghcr.io` image.

**Likely cause:** The GHCR registry credential is missing, expired, or has insufficient permissions.

**What to check:**

- Go to **Registry Credentials** under Administration. Look for a `ghcr.io` credential and verify it's active.
- Click the test connection button on the credential to verify it works.
- On the GitHub connectivity page, check if the Package Access Token is still configured.

**Fix:** If the credential is missing, go to the GitHub connectivity page and click **Refresh GHCR Token** to recreate it. If the PAT was revoked, generate a new one and enter it in the Package Access section.

---

## Rate limiting errors

**Symptom:** GitHub-related requests fail intermittently with errors mentioning rate limits.

**Likely cause:** The GitHub API has rate limits for authenticated requests (5,000/hour for app installations, 5,000/hour for PATs).

**What to check:**

- The error message usually includes rate limit details.
- Consider how frequently you're accessing the GitHub pages.

**Fix:** Rate limits reset hourly. Reduce the frequency of page refreshes if you're hitting limits. For most use cases, the default polling interval is well within limits.
