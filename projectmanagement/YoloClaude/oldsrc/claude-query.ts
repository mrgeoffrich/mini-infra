import { query } from "@anthropic-ai/claude-code";
import { getClaudeCodeExecutablePath } from "./claude-utils.js";

export interface StoryProgress {
    stories_remaining: boolean;
    current_story: number;
    total_stories: number;
    completed_stories: number;
    remaining_stories: number;
    next_story_title: string;
}

export async function queryClaudeCode(storyFile: string): Promise<StoryProgress> {
    const prompt = `Are there any stories left to implement in ${storyFile} ? What story number are we up to? Return in json format yes or no and the story number we are up to.
    
return the json in a format like this
{
  "stories_remaining": true,
  "current_story": 2,
  "total_stories": 10,
  "completed_stories": 1,
  "remaining_stories": 9,
  "next_story_title": "Create Azure Settings API Endpoints"
}`
    const claudeCodePath = getClaudeCodeExecutablePath();

    for await (const message of query({
        prompt,
        options: {
            maxTurns: 200,
            abortController: new AbortController(),
            pathToClaudeCodeExecutable: claudeCodePath,
            cwd: process.cwd()
        }
    })) {
        if (message.type === "result" && message.subtype === "success") {
            try {
                // Extract JSON from markdown code fences if present
                let jsonString = message.result.trim();
                const codeBlockMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
                if (codeBlockMatch && codeBlockMatch[1]) {
                    jsonString = codeBlockMatch[1].trim();
                }
                
                const parsed = JSON.parse(jsonString) as StoryProgress;
                return parsed;
            } catch (error) {
                throw new Error(`Failed to parse JSON response: ${message.result}. Error: ${error}`);
            }
        }
    }
    throw new Error("No result received from Claude Code");
}

export function parseYesNoResponse(response: string): "yes" | "no" | "unclear" {
    const answer = response.toLowerCase().trim();
    if (answer.includes("yes")) {
        return "yes";
    } else if (answer.includes("no")) {
        return "no";
    } else {
        return "unclear";
    }
}