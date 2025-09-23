Please analyze and fix the GitHub issue: $ARGUMENTS.

Follow these steps:

1. Use `gh issue view` to get the issue details
2. Understand the problem described in the issue
3. Search the codebase for relevant files including
 - prisma database model changes
 - shared library model changes
 - server API route changes
 - server API test changes
 - server services changes
 - server services test changes
 - client changes including react hooks, components and pages
4. Detail a comprehensive implementation plan and create a todo list to execute off this plan
5. Implement the necessary changes to fix the issue
5. Write and run tests to verify the fix
6. Ensure code passes linting, the build and type checking
7. Create a new feature branch from main
7. Create a descriptive commit message and commit the changes
8. Push and create a PR with a descriptive PR message

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks.