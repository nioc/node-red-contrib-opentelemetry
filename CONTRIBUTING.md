## Contributing

The project is open and any contribution is welcome!

There are many ways to contribute such as reporting bugs, suggesting features and submitting pull requests.

### Developers guidelines

#### Discuss first

> [!IMPORTANT]
> Before writing code / submitting pull request, please [open a discussion](https://github.com/nioc/node-red-contrib-opentelemetry/discussions/new?category=ideas) in order to discuss your idea.

#### Architecture

This node must remain lightweight and resource-efficient.

#### Code style

When writing some code, lint it with [provided rules](.eslintrc.json): `pnpm run lint`.

> [!IMPORTANT]
> your pull request will not be merged until checks succeed.

Add relevant comments to the code, trying to keep them concise. If the comment is long, don't use line breaks too frequently (150 characters is okay).

#### Commits message

Read [conventional commits](https://www.conventionalcommits.org/) and write your commit messages accordingly.

#### Tests

Before packaging, the application's functionality is validated by a set of tests.
It is strongly recommended that you include tests for your new features or update existing tests affected by your changes.

#### AI

I'm not a big fan of AI-generated code (especially because of its environmental impact), but if you plan to use it, please mention it in the discussion. Of course, you must understand the generated code and be able to justify the choices made. The commits you push to your PR will be **your responsibility**, not the AI's; make sure your commits do not mention the tool in a `Co-Authored-By` field.
