# Vendored: PayPal Server SDK context plugin (TypeScript skills)

These skills are **not ours**. They are the TypeScript skill set from PayPal's
Server SDK Context Plugin, built with APIMatic and published for the PayPal AI
Hackathon 2026:

  https://github.com/paypaldev/server-sdk-context-plugin-preview

Licence: MIT. Author: PayPal Server SDKs <ppcp-server-sdks@paypal.com>.
Only the `typescript/` set is vendored — this project is TypeScript; the
csharp, java, php, python and ruby sets are omitted. Nothing has been edited.

## Why they are copied in rather than installed

The official installer is:

    npx context-plugins install https://github.com/paypaldev/server-sdk-context-plugin-preview

That executes code fetched from a remote URL, which the sandbox this project
was built in refuses. Rather than work around that, the repository was cloned,
inspected (61 files, all Markdown, no executable code), and the TypeScript
skills copied to this documented project-scope skills location.

Running the official installer as well is recommended and changes nothing here.
