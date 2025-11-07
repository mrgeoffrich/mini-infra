# Trivy Vulnerability Scanning Guide for Mini Infra

## Overview
Trivy can scan multiple aspects of your application:
1. **Container Images** - OS packages and application dependencies in Docker images
2. **Filesystem** - Node.js dependencies, package-lock.json files
3. **Dockerfile** - Misconfigurations and best practices
4. **Secrets** - Exposed credentials, API keys, tokens

## Platform-Specific Instructions

This guide includes commands for:
- 🪟 **Windows (PowerShell)** - For PowerShell users
- 🪟 **Windows (Git Bash)** - For Git Bash users on Windows
- 🐧 **Linux/Mac** - For Unix-like systems

**Key Differences:**
- **Volume Paths**: Windows requires special path formatting for Docker volumes
- **Line Continuation**: PowerShell uses backtick `` ` ``, Bash uses backslash `\`
- **Docker Socket**: Windows with Git Bash uses `//var/run/docker.sock`

---

## 1. Scan Docker Image (After Build)

Scans the entire built container image including OS packages and all bundled dependencies.

### Basic Image Scan

**🪟 Windows (PowerShell):**
```powershell
cd C:\Repos\mini-infra
docker build -t mini-infra:latest .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image mini-infra:latest
```

**🪟 Windows (Git Bash):**
```bash
cd /c/Repos/mini-infra
docker build -t mini-infra:latest .
docker run --rm -v "//var/run/docker.sock:/var/run/docker.sock" aquasec/trivy image mini-infra:latest
```

**🐧 Linux/Mac:**
```bash
cd ~/mini-infra  # or your project path
docker build -t mini-infra:latest .
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image mini-infra:latest
```

### Only HIGH and CRITICAL Vulnerabilities

**🪟 Windows (PowerShell):**
```powershell
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock `
  aquasec/trivy image --severity HIGH,CRITICAL mini-infra:latest
```

**🪟 Windows (Git Bash):**
```bash
docker run --rm -v "//var/run/docker.sock:/var/run/docker.sock" \
  aquasec/trivy image --severity HIGH,CRITICAL mini-infra:latest
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy image --severity HIGH,CRITICAL mini-infra:latest
```

### Scan with Exit Code (for CI/CD)

**All Platforms:**
```bash
# Exit with code 1 if HIGH or CRITICAL vulnerabilities found
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy image --severity HIGH,CRITICAL --exit-code 1 mini-infra:latest
```

### Generate JSON Report

**🪟 Windows (PowerShell):**
```powershell
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock `
  -v "C:\Repos\mini-infra:C:\output" `
  aquasec/trivy image --format json --output C:\output\trivy-image-report.json mini-infra:latest
```

**🪟 Windows (Git Bash):**
```bash
docker run --rm -v "//var/run/docker.sock:/var/run/docker.sock" \
  -v "//c/Repos/mini-infra://output" \
  aquasec/trivy image --format json --output //output/trivy-image-report.json mini-infra:latest
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$(pwd):/output" \
  aquasec/trivy image --format json --output /output/trivy-image-report.json mini-infra:latest
```

---

## 2. Scan Node.js Dependencies (Filesystem)

Scans package.json and package-lock.json files to detect vulnerable Node.js packages.

### Scan All Workspaces

**🪟 Windows (PowerShell):**
```powershell
cd C:\Repos\mini-infra
docker run --rm -v "${PWD}:/workspace" `
  aquasec/trivy fs --severity HIGH,CRITICAL /workspace
```

**🪟 Windows (Git Bash):**
```bash
cd /c/Repos/mini-infra
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy fs --severity HIGH,CRITICAL //workspace
```

**🐧 Linux/Mac:**
```bash
cd ~/mini-infra  # or your project path
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy fs --severity HIGH,CRITICAL /workspace
```

### Scan Specific Package (e.g., server)

**🪟 Windows (PowerShell):**
```powershell
docker run --rm -v "C:\Repos\mini-infra\server:/workspace" `
  aquasec/trivy fs --severity HIGH,CRITICAL /workspace
```

**🪟 Windows (Git Bash):**
```bash
docker run --rm -v "//c/Repos/mini-infra/server://workspace" \
  aquasec/trivy fs --severity HIGH,CRITICAL //workspace
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v "$(pwd)/server:/workspace" \
  aquasec/trivy fs --severity HIGH,CRITICAL /workspace
```

### Scan Only Vulnerabilities (Skip Secrets)

**🪟 Windows (Git Bash):**
```bash
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy fs --scanners vuln --severity HIGH,CRITICAL //workspace
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy fs --scanners vuln --severity HIGH,CRITICAL /workspace
```

### Generate HTML Report

**🪟 Windows (Git Bash):**
```bash
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy fs --format template --template "@contrib/html.tpl" \
  --output //workspace/trivy-deps-report.html //workspace
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy fs --format template --template "@contrib/html.tpl" \
  --output /workspace/trivy-deps-report.html /workspace
```

---

## 3. Scan Dockerfile for Misconfigurations

Checks Dockerfile against best practices and security policies.

### Scan Dockerfile

**🪟 Windows (PowerShell):**
```powershell
cd C:\Repos\mini-infra
docker run --rm -v "${PWD}:/workspace" `
  aquasec/trivy config --severity HIGH,CRITICAL /workspace/Dockerfile
```

**🪟 Windows (Git Bash):**
```bash
cd /c/Repos/mini-infra
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy config --severity HIGH,CRITICAL //workspace/Dockerfile
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy config --severity HIGH,CRITICAL /workspace/Dockerfile
```

### Scan All Config Files

**🪟 Windows (Git Bash):**
```bash
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy config //workspace
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy config /workspace
```

---

## 4. Scan for Secrets

Detects exposed secrets, API keys, passwords, and tokens in code.

### Scan for Secrets Only

**🪟 Windows (PowerShell):**
```powershell
cd C:\Repos\mini-infra
docker run --rm -v "${PWD}:/workspace" `
  aquasec/trivy fs --scanners secret /workspace
```

**🪟 Windows (Git Bash):**
```bash
cd /c/Repos/mini-infra
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy fs --scanners secret //workspace
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy fs --scanners secret /workspace
```

### Scan Secrets with Custom Patterns

**🪟 Windows (Git Bash):**
```bash
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy fs --scanners secret --severity HIGH,CRITICAL //workspace
```

**🐧 Linux/Mac:**
```bash
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy fs --scanners secret --severity HIGH,CRITICAL /workspace
```

---

## 5. Comprehensive Scan (All in One)

Run all scans together for complete coverage.

### 🪟 Windows (PowerShell)

Save as `trivy-scan.ps1`:
```powershell
# Comprehensive Trivy scan script for Windows PowerShell

Write-Host "=== Building Docker Image ==="
cd C:\Repos\mini-infra
docker build -t mini-infra:scan .

Write-Host ""
Write-Host "=== Scanning Docker Image ==="
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock `
  aquasec/trivy image --severity HIGH,CRITICAL mini-infra:scan

Write-Host ""
Write-Host "=== Scanning Node.js Dependencies ==="
docker run --rm -v "${PWD}:/workspace" `
  aquasec/trivy fs --scanners vuln --severity HIGH,CRITICAL /workspace

Write-Host ""
Write-Host "=== Scanning Dockerfile Configuration ==="
docker run --rm -v "${PWD}:/workspace" `
  aquasec/trivy config --severity HIGH,CRITICAL /workspace/Dockerfile

Write-Host ""
Write-Host "=== Scanning for Secrets ==="
docker run --rm -v "${PWD}:/workspace" `
  aquasec/trivy fs --scanners secret /workspace
```

Run with: `.\trivy-scan.ps1`

### 🪟 Windows (Git Bash)

Save as `trivy-scan.sh`:
```bash
#!/bin/bash
# Comprehensive Trivy scan script for Windows Git Bash

echo "=== Building Docker Image ==="
cd /c/Repos/mini-infra
docker build -t mini-infra:scan .

echo ""
echo "=== Scanning Docker Image ==="
docker run --rm -v "//var/run/docker.sock:/var/run/docker.sock" \
  aquasec/trivy image --severity HIGH,CRITICAL mini-infra:scan

echo ""
echo "=== Scanning Node.js Dependencies ==="
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy fs --scanners vuln --severity HIGH,CRITICAL //workspace

echo ""
echo "=== Scanning Dockerfile Configuration ==="
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy config --severity HIGH,CRITICAL //workspace/Dockerfile

echo ""
echo "=== Scanning for Secrets ==="
docker run --rm -v "//c/Repos/mini-infra://workspace" \
  aquasec/trivy fs --scanners secret //workspace
```

Run with: `bash trivy-scan.sh`

### 🐧 Linux/Mac

Save as `trivy-scan.sh`:
```bash
#!/bin/bash
# Comprehensive Trivy scan script for Linux/Mac

echo "=== Building Docker Image ==="
cd ~/mini-infra  # or your project path
docker build -t mini-infra:scan .

echo ""
echo "=== Scanning Docker Image ==="
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock \
  aquasec/trivy image --severity HIGH,CRITICAL mini-infra:scan

echo ""
echo "=== Scanning Node.js Dependencies ==="
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy fs --scanners vuln --severity HIGH,CRITICAL /workspace

echo ""
echo "=== Scanning Dockerfile Configuration ==="
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy config --severity HIGH,CRITICAL /workspace/Dockerfile

echo ""
echo "=== Scanning for Secrets ==="
docker run --rm -v "$(pwd):/workspace" \
  aquasec/trivy fs --scanners secret /workspace
```

Run with: `bash trivy-scan.sh`

---

## 6. CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
name: Security Scan

on: [push, pull_request]

jobs:
  trivy-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Build Docker Image
        run: docker build -t mini-infra:${{ github.sha }} .

      - name: Run Trivy Vulnerability Scanner
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'mini-infra:${{ github.sha }}'
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'HIGH,CRITICAL'

      - name: Upload Trivy Results to GitHub Security
        uses: github/codeql-action/upload-sarif@v2
        with:
          sarif_file: 'trivy-results.sarif'

      - name: Fail if HIGH or CRITICAL vulnerabilities found
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: 'mini-infra:${{ github.sha }}'
          exit-code: '1'
          severity: 'HIGH,CRITICAL'
```

---

## Common Severity Levels

- **CRITICAL** - Immediate action required
- **HIGH** - Should be fixed soon
- **MEDIUM** - Fix when convenient
- **LOW** - Informational
- **UNKNOWN** - Severity not determined

## Useful Flags

- `--severity HIGH,CRITICAL` - Filter by severity
- `--exit-code 1` - Exit with error if vulnerabilities found (for CI/CD)
- `--format json` - Output as JSON
- `--format table` - Human-readable table (default)
- `--scanners vuln,secret,config` - Choose which scanners to run
- `--ignore-unfixed` - Skip vulnerabilities with no available fix
- `--timeout 10m` - Set scan timeout

## Tips

1. **Regular Scanning**: Run Trivy before every deployment
2. **Fail Fast**: Use `--exit-code 1` in CI/CD to block vulnerable builds
3. **Focus on Fixable**: Use `--ignore-unfixed` to reduce noise
4. **Layer Caching**: Trivy caches vulnerability databases for faster subsequent scans
5. **Keep Updated**: Pull the latest Trivy image regularly for updated vulnerability data
6. **Windows Users**: Use Git Bash for better compatibility with Docker volume mounts
7. **PowerShell Users**: Use `${PWD}` for current directory in volume mounts

---

## Windows-Specific Notes

### Path Formatting in Git Bash
- **Local paths**: Use `/c/Repos/mini-infra` (Unix-style)
- **Docker volumes**: Use `//c/Repos/mini-infra://workspace` (double slashes)
- **Docker socket**: Use `//var/run/docker.sock:/var/run/docker.sock`

### Path Formatting in PowerShell
- **Local paths**: Use `C:\Repos\mini-infra` (Windows-style)
- **Docker volumes**: Use `${PWD}:/workspace` or full path `C:\Repos\mini-infra:/workspace`
- **Docker socket**: Use `/var/run/docker.sock:/var/run/docker.sock` (no double slashes)

### Troubleshooting Windows
- If you get "access denied" errors, ensure Docker Desktop is running
- If volume mounts fail, try the alternative path format
- For Git Bash, ensure you're using double slashes `//` for absolute paths

---

## Quick Reference

### All Platforms
| What to Scan | Description |
|--------------|-------------|
| Docker Image | Scan built container for OS and app vulnerabilities |
| Filesystem | Scan Node.js dependencies (package.json, package-lock.json) |
| Configuration | Check Dockerfile against best practices |
| Secrets | Find exposed credentials and API keys |
| Base Image | Check if base image (node:24-alpine) has vulnerabilities |

### Command Templates

**🪟 Windows (Git Bash):**
```bash
# Image scan
docker run --rm -v "//var/run/docker.sock:/var/run/docker.sock" aquasec/trivy image <image-name>

# Filesystem scan
docker run --rm -v "//c/Repos/mini-infra://workspace" aquasec/trivy fs //workspace

# Config scan
docker run --rm -v "//c/Repos/mini-infra://workspace" aquasec/trivy config //workspace/Dockerfile

# Secret scan
docker run --rm -v "//c/Repos/mini-infra://workspace" aquasec/trivy fs --scanners secret //workspace
```

**🪟 Windows (PowerShell):**
```powershell
# Image scan
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image <image-name>

# Filesystem scan
docker run --rm -v "${PWD}:/workspace" aquasec/trivy fs /workspace

# Config scan
docker run --rm -v "${PWD}:/workspace" aquasec/trivy config /workspace/Dockerfile

# Secret scan
docker run --rm -v "${PWD}:/workspace" aquasec/trivy fs --scanners secret /workspace
```

**🐧 Linux/Mac:**
```bash
# Image scan
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock aquasec/trivy image <image-name>

# Filesystem scan
docker run --rm -v "$(pwd):/workspace" aquasec/trivy fs /workspace

# Config scan
docker run --rm -v "$(pwd):/workspace" aquasec/trivy config /workspace/Dockerfile

# Secret scan
docker run --rm -v "$(pwd):/workspace" aquasec/trivy fs --scanners secret /workspace
```
