#!/usr/bin/env node
import { Command } from "commander";
import { readFileSync } from "fs";
import { execSync } from "child_process";
import { queryClaudeCode, parseYesNoResponse, type StoryProgress } from "./claude-query.js";
import { runStoryClaudeCode } from "./claude-run-story.js";
import { PushoverClient } from "./pushover.js";

const program = new Command();

// Global error handlers for unhandled errors
process.on('uncaughtException', async (error) => {
    await exitWithError(`Uncaught exception: ${error.message}`);
});

process.on('unhandledRejection', async (reason) => {
    await exitWithError(`Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});

// Helper function to send error notifications and exit
async function exitWithError(message: string, exitCode: number = 1): Promise<never> {
    console.error(message);
    
    try {
        if (process.env.PUSHOVER_APP_TOKEN && process.env.PUSHOVER_USER_KEY) {
            const pushover = new PushoverClient();
            await pushover.sendSimpleMessage(
                `Claude Story Runner failed: ${message}`,
                "Claude Story Runner - Error"
            );
            console.log("📱 Error notification sent via Pushover");
        }
    } catch (notificationError) {
        console.error("⚠️  Failed to send error notification:", notificationError instanceof Error ? notificationError.message : notificationError);
    }
    
    process.exit(exitCode);
}

program
    .name("claude-story-runner")
    .description("CLI tool for running Claude Code over a set of stories until completion")
    .version("1.0.0")
    .requiredOption("-s, --story-file <path>", "Path to the markdown file containing stories")
    .requiredOption("-a, --architecture-doc <path>", "Path to the architecture document")
    .option("-b, --branch-prefix <prefix>", "Branch name prefix (default: story)", "story")
    .option("-f, --feature-branch <name>", "Feature branch name to create and use as base for all stories")
    .option("-p, --prompt <prompt>", "Custom prompt to override the default implementation prompt")
    .action(async (options) => {
        const storyFile = options.storyFile;
        const architectureDoc = options.architectureDoc;
        const featureBranchName = options.featureBranch ? `feature/${options.featureBranch}` : null;
        let featureBranchCreated = false;

        let continueRunning = true;

        while (continueRunning) {
            // Check if there are more stories to implement
            console.log(`Checking if there are more stories to implement in ${storyFile}`);

            const storyProgress: StoryProgress = await queryClaudeCode(storyFile);

            // Update terminal title with progress
            if (storyProgress.stories_remaining) {
                process.title = `${storyProgress.current_story}/${storyProgress.total_stories}: ${storyProgress.next_story_title}`;
            } else {
                process.title = `Complete (${storyProgress.completed_stories}/${storyProgress.total_stories})`;
            }

            if (storyProgress.stories_remaining) {
                console.log(`Yes - there are stories left to implement`);
                console.log(`Current story: ${storyProgress.current_story}/${storyProgress.total_stories}`);
                console.log(`Next story: ${storyProgress.next_story_title}`);
                console.log(`Completed: ${storyProgress.completed_stories}, Remaining: ${storyProgress.remaining_stories}`);
            } else {
                console.log("No - all stories are complete");
                console.log(`Total stories completed: ${storyProgress.completed_stories}/${storyProgress.total_stories}`);
                
                // Send Pushover notification if environment variables are set
                try {
                    if (process.env.PUSHOVER_APP_TOKEN && process.env.PUSHOVER_USER_KEY) {
                        const pushover = new PushoverClient();
                        await pushover.sendSimpleMessage(
                            `All ${storyProgress.total_stories} stories have been completed successfully! 🎉`,
                            "Claude Story Runner - Complete"
                        );
                        console.log("📱 Pushover notification sent");
                    }
                } catch (error) {
                    console.error("⚠️  Failed to send Pushover notification:", error instanceof Error ? error.message : error);
                }
                
                continueRunning = false;
                break;
            }

            const branchName = `${options.branchPrefix}-${storyProgress.current_story}`;

            // Check if branch already exists
            try {
                execSync(`git rev-parse --verify ${branchName}`, { stdio: 'pipe' });
                console.log(`Branch ${branchName} already exists. Exiting.`);
                process.exit(0);
            } catch (error) {
                // Branch doesn't exist, continue
            }

            // Handle feature branch creation and story branch creation
            try {
                if (featureBranchName && !featureBranchCreated) {
                    // First story: Create feature branch from main
                    console.log(`Creating feature branch: ${featureBranchName}`);
                    execSync('git checkout main', { stdio: 'inherit' });
                    execSync(`git checkout -b ${featureBranchName}`, { stdio: 'inherit' });
                    featureBranchCreated = true;
                }

                const baseBranch = featureBranchName || 'main';
                console.log(`Creating story branch ${branchName} from ${baseBranch}`);
                execSync(`git checkout ${baseBranch}`, { stdio: 'inherit' });
                execSync(`git checkout -b ${branchName}`, { stdio: 'inherit' });
            } catch (error) {
                await exitWithError(`Failed to create git branch: ${error instanceof Error ? error.message : error}`);
            }

            try {
                await runStoryClaudeCode(storyFile, architectureDoc, options.prompt);
            } catch (error) {
                console.error('\n❌ Claude Code execution failed');
                console.error('═══════════════════════════════════════');

                if (error instanceof Error) {
                    console.error(`Error: ${error.message}`);
                    if (error.stack) {
                        console.error('\nStack trace:');
                        console.error(error.stack);
                    }
                } else {
                    console.error('Unknown error type:', error);
                }

                console.error('═══════════════════════════════════════\n');

                // Clean up the branch
                console.log(`🧹 Cleaning up branch ${branchName} due to failure`);
                try {
                    const baseBranch = featureBranchName || 'main';
                    execSync(`git checkout ${baseBranch}`, { stdio: 'inherit' });
                    execSync(`git branch -D ${branchName}`, { stdio: 'inherit' });
                    console.log(`✅ Successfully cleaned up branch ${branchName}`);
                } catch (cleanupError) {
                    console.error('❌ Failed to clean up branch:');
                    if (cleanupError instanceof Error) {
                        console.error(`   ${cleanupError.message}`);
                    } else {
                        console.error('   Unknown cleanup error:', cleanupError);
                    }
                }
                await exitWithError(`Claude Code execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }

            // Check for changes before committing
            console.log(`Checking for changes in ${branchName}`);
            try {
                // Show git status for debugging
                console.log('Git status:');
                execSync('git status --porcelain', { stdio: 'inherit' });

                execSync('git add .', { stdio: 'inherit' });

                // Check if there are actually staged changes
                try {
                    execSync('git diff --cached --quiet');
                    console.log(`⚠️  No changes to commit for ${branchName} - this may indicate an issue`);
                    console.log('Possible reasons:');
                    console.log('  - Claude Code ran in wrong directory');
                    console.log('  - Files were created outside git repo');
                    console.log('  - Changes were in ignored files');
                    // Don't exit, continue to next iteration to avoid infinite loop
                } catch {
                    // There are staged changes, proceed with commit
                    console.log(`Committing and pushing changes for ${branchName}`);
                    const commitMessage = storyProgress.next_story_title.length > 50
                        ? storyProgress.next_story_title.substring(0, 47) + "..."
                        : storyProgress.next_story_title;
                    execSync(`git commit -m "Implement: ${commitMessage}"`, { stdio: 'inherit' });
                    execSync(`git push origin ${branchName}`, { stdio: 'inherit' });
                }
            } catch (error) {
                await exitWithError(`Failed to commit and push changes: ${error instanceof Error ? error.message : error}`);
            }

            // Merge branch back to base branch (feature branch or main)
            const baseBranch = featureBranchName || 'main';
            console.log(`Merging ${branchName} back to ${baseBranch}`);
            try {
                execSync(`git checkout ${baseBranch}`, { stdio: 'inherit' });
                execSync(`git merge ${branchName}`, { stdio: 'inherit' });
                
                // Only push to origin if not using feature branch workflow
                // (feature branch will be pushed at the end)
                if (!featureBranchName) {
                    execSync(`git push origin ${baseBranch}`, { stdio: 'inherit' });
                }
            } catch (error) {
                await exitWithError(`Failed to merge branch to ${baseBranch}: ${error instanceof Error ? error.message : error}`);
            }
            console.log(`✅ Successfully merged ${branchName} into ${baseBranch}`);
            console.log();
        }

        // Final workflow: if using feature branch, end on feature branch
        if (featureBranchName && featureBranchCreated) {
            console.log(`🎉 All stories completed!`);
            console.log(`📋 Summary:`);
            console.log(`   - All changes are consolidated on the feature branch: ${featureBranchName}`);
            console.log(`   - You are currently on the feature branch`);
            console.log(`   - To merge to main, run: git checkout main && git merge ${featureBranchName}`);
            console.log(`   - Or create a pull request from ${featureBranchName} to main`);
            
            // Send Pushover notification for feature branch completion if not already sent
            try {
                if (process.env.PUSHOVER_APP_TOKEN && process.env.PUSHOVER_USER_KEY) {
                    const pushover = new PushoverClient();
                    await pushover.sendSimpleMessage(
                        `Feature branch ${featureBranchName} completed with all stories implemented! Ready for merge to main.`,
                        "Claude Story Runner - Feature Complete"
                    );
                    console.log("📱 Pushover notification sent for feature completion");
                }
            } catch (error) {
                console.error("⚠️  Failed to send Pushover notification:", error instanceof Error ? error.message : error);
            }
        }
    });

program.parse();