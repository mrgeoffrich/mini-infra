---
description: A prompt to start diagnosis of an issue.
---

We are going to diagnose and issue with application here. The environment we are looking at is %ARGUMENT%.

You need to follow this workflow:
* Ask the user what the issue is and if it can be recreated, and how. Also ask the user what tools you should use to diagnose the issue, including playwright cli, the API the database and the logs.
* Once you understand the issue examine the code base and use those diagnostic tools for form a hypothesis as to what the issue might be.
* Once you have a hypothesis, you need to validate that hypothesis to prove or disprove it.
* Once you think you have a proved hypothesis, articulate to the user what a fix might look like.
* Stop here and ask the user if they would like it fixed or not.

Note: Do not under any circumstance change anything without verifying the change with the user.
