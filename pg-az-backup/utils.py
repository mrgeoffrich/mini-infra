#!/usr/bin/env python3
"""Shared utilities for pg-az-backup scripts."""

import sys
import subprocess


def run_command(command, shell=True, check=True):
    """Run a shell command and handle errors."""
    try:
        result = subprocess.run(
            command,
            shell=shell,
            check=check,
            capture_output=True,
            text=True
        )
        return result
    except subprocess.CalledProcessError as e:
        print(f"Command failed: {command}", file=sys.stderr)
        print(f"Error: {e.stderr}", file=sys.stderr)
        sys.exit(1)
