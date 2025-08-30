import { execSync } from "child_process";
import path from "path";
import fs from "fs";

export function getClaudeCodeExecutablePath(): string {
    try {
        // Get npm global prefix
        const npmPrefix = execSync('npm config get prefix', { encoding: 'utf8' }).trim();

        // The SDK expects the actual CLI file, not the wrapper
        const claudePath = path.join(npmPrefix, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');

        // Check if file exists
        if (!fs.existsSync(claudePath)) {
            throw new Error(`Claude Code CLI not found at ${claudePath}. Please check if Claude Code is installed globally.`);
        }

        return claudePath;
    } catch (error) {
        if (error instanceof Error) {
            throw error;
        }
        throw new Error('Could not determine Claude Code executable path. Is Claude Code installed globally?');
    }
}