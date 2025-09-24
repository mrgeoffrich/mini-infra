Please analyze and fix the GitHub issue: $ARGUMENTS.

Follow these steps:

1. Use `gh issue view` to get the issue details
2. Understand the problem described in the issue and think deeply
3. Search the codebase for relevant files including
 - prisma database model changes
 - shared library model changes
 - server API route changes
 - server API test changes
 - server services changes
 - server services test changes
 - client changes including react hooks, components and pages
4. Detail a comprehensive implementation plan - cut the implementation plan into multiple stages to make the work easier to manage. Include at the top of the plan a list of files that provide relevant context to the planning and decisions. Make sure at each stage a build, test and lint is run to validate changes.
5. Using markdown format, output this plan into a new comment on the github issue.
6. Notify the user that this is complete by running `pushover-cli.exe send "message" -u https://github.com/xxx` and replace the message with a message that should be very short, 10 words maximum, indicating what has been done. After the -u add the link to the github issue.

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks.