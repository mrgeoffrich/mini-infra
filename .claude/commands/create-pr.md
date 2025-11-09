---
description: Create a PR for this branch compared to main
---
Run a build. If the build fails summarise the failures to the user.
If the build passes then examine the changes on this branch compare to main and create a PR for this branch using the gh cli. You will have to write the description to a temporary markdown file and use that to upload the details of the PR. Once the PR is created you can delete the temporary file. Only do all the PR work if the build passed.