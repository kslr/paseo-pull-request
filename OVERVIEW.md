# Pull Request

See your branch's GitHub pull request in the workspace Explorer: its description and CI checks, a merge card with merge method, auto-merge and ready for review, and close, reopen, delete branch or edit the title and description. When the PR conflicts with its base or checks fail, **Fix with agent** starts an agent in the workspace to fix it.

On desktop, a **Create PR** button in the workspace header commits your changes, pushes the branch and opens the pull request in one press. It works on the branch you have checked out and never creates or switches branches; on the default branch, create a branch first. The commit message, PR title and description come from the model set in Paseo's metadata generation settings, which incurs that model's usage.

Works on desktop, web and mobile. Requires Paseo 0.13 or later and the GitHub CLI (`gh`) signed in on the daemon host; GitHub requests run as that account.
