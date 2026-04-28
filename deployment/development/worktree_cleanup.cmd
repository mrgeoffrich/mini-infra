@echo off
setlocal
set "SCRIPT_DIR=%~dp0"
pushd "%SCRIPT_DIR%..\.."
call pnpm dlx tsx@4.21.0 "%SCRIPT_DIR%worktree-cleanup.ts" %*
set "RC=%ERRORLEVEL%"
popd
exit /b %RC%
