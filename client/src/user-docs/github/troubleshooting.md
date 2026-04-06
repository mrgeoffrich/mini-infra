---
title: GitHub Integration Troubleshooting
description: Common GitHub integration issues and how to resolve them.
tags:
  - github
  - troubleshooting
  - authentication
---

# GitHub Integration Troubleshooting

---

## GitHub App setup redirects back but shows an error

**Symptom:** After approving the GitHub App on GitHub, you are redirected back to Mini Infra but the page shows an error instead of a connected state.

**Likely cause:** The OAuth callback code expired (they are valid for only a few minutes), or the setup request failed.

**What to check:** Look at the error message on the page. Check if there is a "Remove App" button — if so, the app was partially created.

**Fix:** Click **Remove App** to clear the partial state, then click **Connect to GitHub** again and complete the flow promptly without delay.

---

## Packages tab is empty or shows an error

**Symptom:** The Packages tab shows no packages or an error message about authentication.

**Likely cause:** The **Package Access Token** is not configured, or the token does not have the `read:packages` scope.

**What to check:** On the GitHub connectivity page, look at the **Package Access Token** status badge. If it shows "Not Configured" (amber), the token is missing.

**Fix:** Generate a new Personal Access Token on GitHub with the `read:packages` scope, then paste it into the Package Access Token field and save.

---

## Repositories tab shows "No repositories found"

**Symptom:** The Repositories tab is empty even though you have repositories on GitHub.

**Likely cause:** The GitHub App is not installed on the account or organization that owns the repositories, or the app installation was not granted access to those repositories.

**What to check:** In the GitHub App installation settings on GitHub, check which repositories the app has access to.

**Fix:** Reinstall or update the GitHub App installation to grant access to the desired repositories.

---

## Actions tab shows "No workflow runs found"

**Symptom:** After selecting a repository, the Actions tab shows no workflow runs.

**Likely cause:** The repository has no workflow runs, or GitHub Actions has not been enabled for that repository.

**What to check:** Open the repository on GitHub and check the Actions tab directly to verify runs exist.

**Fix:** If Actions are enabled and runs exist on GitHub but not in Mini Infra, try refreshing. If the issue persists, disconnect and reconnect the GitHub App.

---

## Bug report test connection fails

**Symptom:** Clicking **Test Connection** on the Bug Report Settings page returns an error.

**Likely cause:** The Personal Access Token is invalid, expired, or does not have the `repo` scope. The repository owner or name may also be incorrect.

**What to check:** Verify the token starts with `ghp_` and has not expired. Check the owner and repository name fields for typos.

**Fix:** Generate a new token with the `repo` scope and update the settings. Verify the repository URL on GitHub to confirm owner and name are correct.

---

## "Test Connection" passes but creating a bug report fails

**Symptom:** The test connection succeeds but bug reports are not created.

**Likely cause:** The token has read access (`repo:status`) but not write access (`repo`). Issues require write access.

**What to check:** Review the token's scopes on GitHub — go to **Settings → Developer settings → Personal access tokens** and check which scopes are granted.

**Fix:** Regenerate the token with the full `repo` scope (not just `repo:status` or `public_repo`).

---
