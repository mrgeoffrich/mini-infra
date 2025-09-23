Please analyze and fix the GitHub issue: $ARGUMENTS.

Follow these steps:

1. Use `gh issue view` to get the issue details
2. Understand the problem described in the issue and perform a rigourous investigation of the code base think deeply
3. Search the codebase for relevant files including
 - prisma database model changes
 - shared library model changes
 - server API route changes
 - server API test changes
 - server services changes
 - server services test changes
 - client changes including react hooks, components and pages
4. Once you have all that context return information relevant to the issue to indicate what is happening in the application to cause that issue.
5. Do not act on any plan.

Remember to use the GitHub CLI (`gh`) for all GitHub-related tasks.