Here is a single feature to be implemented - make sure to only implement this feature and think deeply:

<feature>
$ARGUMENT
</feature>

You are an experienced software developer tasked with creating user stories for a medication tracker application. Your goal is to break down the given feature into small, concrete, and implementable tasks.

Before creating the user stories, please review the project specifications in the file @projectmanagement\mini_infra_spec.md and also ensure you are aware of the technical specifications in @projectmanagement\mini_infra_tech_spec.md

First, analyze the feature and break it down into components. Make sure to make API type defintions changes with any API changes. Do this work inside a thinking block, wrapped in <feature_breakdown> tags:

<feature_breakdown>
1. Explain the feature in detail.
2. List all existing screens in the application.
3. Identify potential new screens needed for the feature.
4. Identify potential user roles involved in the feature.
5. Outline the technical changes required for implementation, including:
   a. Database model changes
   b. Backend changes including type definitions and API endpoints
   c. Frontend changes
6. Break down the feature into smaller components.
7. List possible edge cases and error scenarios.
</feature_breakdown>

Next, plan the user stories based on your analysis. Continue working inside the thinking block, using <story_planning> tags for this step:

<story_planning>
1. List the user stories you plan to create, ensuring each represents a small, concrete piece of work.
2. For each story, briefly outline:
   - The goal
   - Key tasks
   - Any dependencies on other stories
3. Order the stories based on the following order:
   a. Database model changes
   b. Backend API changes and backend API type definitions
   c. Backend tests
   d. React hooks
   e. Frontend changes
4. Review the order and adjust if necessary to ensure dependencies are addressed before dependent stories.
5. Confirm that each story is small enough to be implemented by an AI system in a single session.
</story_planning>

Now, create the user stories following this format:

```markdown
# Feature: [Feature Name]

## User Story 1: [Story Title]

**Goal:** [Brief description of the story's objective]

**Status:** Not Started

**Tasks:**

1. [Task 1]
2. [Task 2]
3. [Task 3]

**Acceptance Criteria:**

- Run prettier over all new files to format them
- Run build to ensure no errors
- Run linter to ensure no errors
- Update CLAUDE.md with new details
- Mark the story as done in the markdown file for it.

## User Story 2: [Story Title]

[Follow the same structure as User Story 1]

[Continue with additional user stories as needed]
```

Ensure that you use the same acceptance criteria for all user stories, as specified above.

Your final output should consist only of the user stories, without repeating any instructions or explanations. Write the output to a new markdown file in the projectmanagement folder, and do not duplicate or rehash any of the work you did in the feature breakdown or story planning sections. Do not use the todo tool in this process. Read other project files as appropriate.
