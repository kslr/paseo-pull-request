# Paseo Pull Request

Create, check and merge GitHub pull requests without leaving your [Paseo](https://paseo.sh) workspace.

![Pull Request panel next to the code](docs/screenshots/overview.png)

## Features

- **One-click PR**: commit, push and open the PR, with the message and description written for you.
- **PR panel**: status, CI checks and description next to your code.
- **Merge in place**: merge, squash, rebase or auto-merge without opening GitHub.
- **Fix with agent**: hand conflicts or failing checks to an agent.
- **Everywhere**: desktop, web and mobile, GitHub and GitHub Enterprise.

## Requirements

- Paseo 0.13 or later
- [GitHub CLI](https://cli.github.com) signed in (`gh auth login`) on the machine running the Paseo daemon
- A Git repository with a GitHub remote

## Installation

```sh
paseo plugin add kslr/paseo-pull-request
```

To update:

```sh
paseo plugin update paseo-pull-request
```

## Usage

Open a Git workspace, then pick **Pull Request** in the Explorer or run **Open pull request** from the Command Center. On desktop, the **Create PR** button is in the workspace header.

## Acknowledgements

Inspired by [T3 Code](https://github.com/pingdotgg/t3code).

## License

[GPL-3.0](LICENSE)
