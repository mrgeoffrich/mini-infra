Please analyze the plan in the following github issue and implement a single stage: $ARGUMENTS.

Follow these steps:

1. Switch to main branch and pull.
2. Use `gh issue view` to get the issue details
3. The github issue will have a plan and potentially some messages that stages have been completed. If none have been completed start with stage 1 otherwise pick the next stage to be done.
4. create a feature branch which includes the stage number to use from main.
5. The plan should list a set of files to bring into context, go read them.
6. Create a todo list to execute this one stage.
7. Implement the todo list.
8. Make sure validation is done and issues are fixed before continuing.
9. Commit all the changes and push the branch up.
10. Open a PR and make sure to link back to the original issue, and fill out the change details in the PR description and title.
11. Notify the user that this is complete by running `pushover-cli send "message" -u https://github.com/xxx` and replace the message with a message that should be very short, 10 words maximum, indicating what has been done. After the -u add the link to the github issue.
12. Post a comment on issue $ARGUMENT saying the PR is ready and the stage it is for.

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks.