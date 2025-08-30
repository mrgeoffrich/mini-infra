import { query } from "@anthropic-ai/claude-code";
import { getClaudeCodeExecutablePath } from "./claude-utils.js";

// ANSI color codes for console output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
};

interface ClaudeMessage {
    type: string;
    subtype?: string;
    message?: {
        content: Array<{
            type: string;
            text?: string;
            name?: string;
            input?: any;
        }>;
    };
    session_id?: string;
    cwd?: string;
    model?: string;
    tools?: string[];
    result?: string;
}

function formatSystemMessage(msg: ClaudeMessage): void {
    if (msg.subtype === "init") {
        console.log(`${colors.cyan}${colors.bright}🚀 Claude Code Session Started${colors.reset}`);
        console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
        console.log(`${colors.blue}📂 Working Directory:${colors.reset} ${msg.cwd}`);
        console.log(`${colors.blue}🧠 Model:${colors.reset} ${msg.model}`);
        console.log(`${colors.blue}🔧 Available Tools:${colors.reset} ${msg.tools?.length || 0} tools`);
        console.log(`${colors.blue}🆔 Session ID:${colors.reset} ${msg.session_id?.substring(0, 8)}...`);
        console.log();
    }
}

function formatTodoWriteOutput(tool: any): void {
    console.log(`${colors.magenta}📝 Todo List Update:${colors.reset}`);

    if (tool.input?.todos && Array.isArray(tool.input.todos)) {
        const todos = tool.input.todos;
        const completed = todos.filter((t: any) => t.status === 'completed');
        const inProgress = todos.filter((t: any) => t.status === 'in_progress');
        const pending = todos.filter((t: any) => t.status === 'pending');

        // Show summary
        console.log(`${colors.dim}   ${completed.length} completed, ${inProgress.length} in progress, ${pending.length} pending${colors.reset}`);
        console.log();

        // Show completed tasks (collapsed)
        if (completed.length > 0) {
            console.log(`${colors.green}   ✅ Completed (${completed.length}):${colors.reset}`);
            completed.slice(-3).forEach((todo: any) => {
                console.log(`${colors.dim}      • ${todo.content}${colors.reset}`);
            });
            if (completed.length > 3) {
                console.log(`${colors.dim}      ... and ${completed.length - 3} more${colors.reset}`);
            }
            console.log();
        }

        // Show in-progress tasks (highlighted)
        if (inProgress.length > 0) {
            console.log(`${colors.yellow}   🔄 In Progress:${colors.reset}`);
            inProgress.forEach((todo: any) => {
                console.log(`${colors.yellow}      → ${todo.activeForm || todo.content}${colors.reset}`);
            });
            console.log();
        }

        // Show next few pending tasks
        if (pending.length > 0) {
            console.log(`${colors.blue}   📋 Next Up:${colors.reset}`);
            pending.slice(0, 5).forEach((todo: any, index: number) => {
                const bullet = index === 0 ? '▶' : '•';
                const color = index === 0 ? colors.cyan : colors.dim;
                console.log(`${color}      ${bullet} ${todo.content}${colors.reset}`);
            });
            if (pending.length > 5) {
                console.log(`${colors.dim}      ... and ${pending.length - 5} more tasks${colors.reset}`);
            }
            console.log();
        }
    } else {
        // Fallback to regular formatting if todos structure is unexpected
        console.log(`${colors.dim}   Updating todo list...${colors.reset}`);
        console.log();
    }
}

function formatWriteOutput(tool: any): void {
    console.log(`${colors.magenta}📄 Writing file:${colors.reset}`);

    if (tool.input?.file_path) {
        // Extract just the filename from the full path
        const fileName = tool.input.file_path.split(/[/\\]/).pop() || tool.input.file_path;
        const fullPath = tool.input.file_path;

        console.log(`${colors.cyan}   📁 ${fileName}${colors.reset}`);
        console.log(`${colors.dim}   ${fullPath}${colors.reset}`);

        if (tool.input.content) {
            const lines = tool.input.content.split('\n');
            const previewLines = lines.slice(0, 5);
            const totalLines = lines.length;

            console.log(`${colors.dim}   ┌─ Preview (${previewLines.length}/${totalLines} lines) ─${colors.reset}`);
            previewLines.forEach((line: string, index: number) => {
                const lineNum = (index + 1).toString().padStart(2, ' ');
                // Truncate very long lines
                const displayLine = line.length > 80 ? line.substring(0, 77) + '...' : line;
                console.log(`${colors.dim}   │ ${lineNum} ${displayLine}${colors.reset}`);
            });

            if (totalLines > 5) {
                console.log(`${colors.dim}   └─ ... and ${totalLines - 5} more lines${colors.reset}`);
            } else {
                console.log(`${colors.dim}   └─ End of file${colors.reset}`);
            }
        }
        console.log();
    } else {
        // Fallback if structure is unexpected
        console.log(`${colors.dim}   Writing file...${colors.reset}`);
        console.log();
    }
}

function formatEditOutput(tool: any): void {
    console.log(`${colors.magenta}✏️  Editing file:${colors.reset}`);

    if (tool.input?.file_path) {
        // Extract just the filename from the full path
        const fileName = tool.input.file_path.split(/[/\\]/).pop() || tool.input.file_path;
        const fullPath = tool.input.file_path;

        console.log(`${colors.cyan}   📁 ${fileName}${colors.reset}`);
        console.log(`${colors.dim}   ${fullPath}${colors.reset}`);

        if (tool.input.old_string && tool.input.new_string) {
            const oldLines = tool.input.old_string.split('\n');
            const newLines = tool.input.new_string.split('\n');

            // Show a brief summary
            console.log(`${colors.dim}   ┌─ Changes ─${colors.reset}`);

            // Show old content (first 3 lines)
            if (oldLines.length > 0) {
                console.log(`${colors.red}   │ - Removing (${oldLines.length} lines):${colors.reset}`);
                oldLines.slice(0, 3).forEach((line: string) => {
                    const displayLine = line.length > 60 ? line.substring(0, 57) + '...' : line;
                    console.log(`${colors.red}   │   - ${displayLine}${colors.reset}`);
                });
                if (oldLines.length > 3) {
                    console.log(`${colors.red}   │   ... and ${oldLines.length - 3} more lines${colors.reset}`);
                }
            }

            // Show new content (first 3 lines) 
            if (newLines.length > 0) {
                console.log(`${colors.green}   │ + Adding (${newLines.length} lines):${colors.reset}`);
                newLines.slice(0, 3).forEach((line: string) => {
                    const displayLine = line.length > 60 ? line.substring(0, 57) + '...' : line;
                    console.log(`${colors.green}   │   + ${displayLine}${colors.reset}`);
                });
                if (newLines.length > 3) {
                    console.log(`${colors.green}   │   ... and ${newLines.length - 3} more lines${colors.reset}`);
                }
            }

            console.log(`${colors.dim}   └─ Net change: ${newLines.length > oldLines.length ? '+' : ''}${newLines.length - oldLines.length} lines${colors.reset}`);
        }
        console.log();
    } else {
        // Fallback if structure is unexpected
        console.log(`${colors.dim}   Editing file...${colors.reset}`);
        console.log();
    }
}

function formatAssistantMessage(msg: ClaudeMessage): void {
    if (!msg.message?.content) return;

    const hasText = msg.message.content.some(item => item.type === "text" && item.text);
    const toolUses = msg.message.content.filter(item => item.type === "tool_use");

    if (hasText) {
        console.log(`${colors.green}${colors.bright}🤖 Claude:${colors.reset}`);
        msg.message.content.forEach(item => {
            if (item.type === "text" && item.text) {
                // Format the text with proper indentation
                const lines = item.text.split('\n');
                lines.forEach(line => {
                    console.log(`${colors.white}   ${line}${colors.reset}`);
                });
            }
        });
        console.log();
    }

    if (toolUses.length > 0) {
        toolUses.forEach(tool => {
            if (tool.name === "TodoWrite") {
                formatTodoWriteOutput(tool);
            } else if (tool.name === "Write") {
                formatWriteOutput(tool);
            } else if (tool.name === "Edit") {
                formatEditOutput(tool);
            } else {
                console.log(`${colors.magenta}🔧 Using tool:${colors.reset} ${colors.yellow}${tool.name}${colors.reset}`);
                if (tool.input && Object.keys(tool.input).length > 0) {
                    const inputStr = JSON.stringify(tool.input, null, 2);
                    const lines = inputStr.split('\n');
                    lines.forEach((line, index) => {
                        if (index === 0) {
                            console.log(`${colors.dim}   ${line}${colors.reset}`);
                        } else {
                            console.log(`${colors.dim}   ${line}${colors.reset}`);
                        }
                    });
                }
                console.log();
            }
        });
    }
}

function formatUserMessage(msg: ClaudeMessage): void {
    // User messages typically contain tool results
    console.log(`${colors.blue}📋 Tool Result:${colors.reset}`);
    console.log(`${colors.dim}   Processing...${colors.reset}`);
    console.log();
}

function formatResultMessage(msg: ClaudeMessage): void {
    if (msg.subtype === "success") {
        console.log(`${colors.green}${colors.bright}✅ Story Implementation Complete!${colors.reset}`);
        console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
        if (msg.result) {
            const lines = msg.result.split('\n');
            lines.forEach(line => {
                console.log(`${colors.white}${line}${colors.reset}`);
            });
        }
        console.log(`${colors.gray}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
    } else if (msg.subtype === "error") {
        console.log(`${colors.red}${colors.bright}❌ Error:${colors.reset} ${msg.result}`);
    }
}

export async function runStoryClaudeCode(storyFile: string, architectureDoc: string, customPrompt?: string): Promise<string> {
    console.log(`${colors.cyan}${colors.bright}📖 Starting Story Implementation${colors.reset}`);
    console.log(`${colors.blue}📄 Story File:${colors.reset} ${storyFile}`);
    console.log(`${colors.blue}🏗️  Architecture Doc:${colors.reset} ${architectureDoc}`);
    console.log();

    const prompt = customPrompt || `/implement-story ${storyFile} ${architectureDoc}`
    const claudeCodePath = getClaudeCodeExecutablePath();

    for await (const message of query({
        prompt,
        options: {
            maxTurns: 200,
            abortController: new AbortController(),
            pathToClaudeCodeExecutable: claudeCodePath,
            cwd: process.cwd(),
            permissionMode: "bypassPermissions"
        }
    })) {
        const msg = message as ClaudeMessage;

        // Format different message types
        switch (msg.type) {
            case "system":
                formatSystemMessage(msg);
                break;
            case "assistant":
                formatAssistantMessage(msg);
                break;
            case "user":
                formatUserMessage(msg);
                break;
            case "result":
                formatResultMessage(msg);
                if (msg.subtype === "success") {
                    return msg.result || "Story implementation completed";
                }
                break;
        }
    }

    throw new Error("No result received from Claude Code");
}

